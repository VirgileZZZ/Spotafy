'use strict';

/* ---------------------------------------------------------------------------
 *  Spotafy Local — module bot Discord
 *
 *  Permet à l'appli de diffuser la musique du dossier /song dans un salon
 *  vocal Discord, via un bot identifié par son token.
 *
 *  Les dépendances (discord.js, @discordjs/voice…) sont chargées de façon
 *  PARESSEUSE : tant que personne n'active Discord, l'appli tourne sans elles.
 *  Si elles ne sont pas installées, on renvoie simplement une erreur claire.
 *
 *  Dépendances nécessaires (voir package.json) :
 *    npm install discord.js @discordjs/voice libsodium-wrappers ffmpeg-static @discordjs/opus
 *  (@discordjs/opus peut être remplacé par opusscript s'il ne compile pas.)
 * ------------------------------------------------------------------------- */

let Discord = null;       // discord.js
let Voice = null;         // @discordjs/voice
let depsError = '';       // message si une dépendance manque

function loadDeps() {
  if (Discord && Voice) return true;
  try {
    Discord = require('discord.js');
    Voice = require('@discordjs/voice');
    depsError = '';
    return true;
  } catch (e) {
    depsError = e && e.message ? e.message : String(e);
    return false;
  }
}

// ffmpeg-static fournit le binaire ffmpeg utilisé pour transcoder MP3/FLAC/etc.
// On l'expose à @discordjs/voice via la variable d'environnement standard, et on
// garde le chemin sous la main pour lancer FFmpeg nous-mêmes (voir play()).
const { spawn } = require('child_process');
let ffmpegPath = null;
try {
  const ff = require('ffmpeg-static');
  if (ff) {
    ffmpegPath = ff;
    if (!process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ff;
  }
} catch { /* pas grave : ffmpeg système éventuellement disponible */ }

// Process FFmpeg courant (chemin rapide). On le tue dès qu'on change de morceau
// ou qu'on arrête, pour éviter les process orphelins.
let ffmpegProc = null;
function killFfmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.kill('SIGKILL'); } catch {}
    ffmpegProc = null;
  }
}

/* État courant, exposé tel quel au front-end. ----------------------------- */
const state = {
  status: 'off',     // off | starting | online | error
  error: '',
  user: '',          // nom#tag du bot
  guildId: '', guildName: '',
  channelId: '', channelName: '',
  playing: false,
  nowPlaying: '',
};

let client = null;
let player = null;
let connection = null;
let leaving = false;   // true pendant un arrêt/déconnexion volontaire (empêche la reconnexion auto)

function getStatus() {
  // hasDeps déclenche un chargement à la volée (sans planter si absentes).
  const hasDeps = loadDeps();
  return { ...state, hasDeps, depsError };
}

/* --- Connexion du bot ----------------------------------------------------- */
async function start(token) {
  if (!loadDeps()) {
    state.status = 'error';
    state.error = "Dépendances manquantes. Lance : npm install";
    return getStatus();
  }
  if (!token || typeof token !== 'string' || token.length < 20) {
    state.status = 'error';
    state.error = 'Token invalide ou manquant.';
    return getStatus();
  }

  await stop(); // repart d'un état propre
  leaving = false;
  state.status = 'starting';
  state.error = '';

  // Diagnostic : affiche une fois l'état des bibliothèques audio dans le terminal.
  try { console.log('[Discord] ' + Voice.generateDependencyReport()); } catch {}

  const { Client, GatewayIntentBits } = Discord;
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  player = Voice.createAudioPlayer({
    behaviors: { noSubscriber: Voice.NoSubscriberBehavior.Play },
  });
  player.on('error', e => {
    state.error = 'Lecteur : ' + (e && e.message || e);
    console.error('[Discord] Erreur lecteur :', e && e.message ? e.message : e);
  });
  player.on('stateChange', (oldS, newS) => {
    console.log('[Discord] Lecteur : ' + oldS.status + ' -> ' + newS.status);
  });
  player.on(Voice.AudioPlayerStatus.Playing, () => { state.playing = true; });
  player.on(Voice.AudioPlayerStatus.Idle, () => { state.playing = false; killFfmpeg(); });
  player.on(Voice.AudioPlayerStatus.Paused, () => { state.playing = false; });

  return await new Promise((resolve) => {
    let settled = false;
    const onReady = () => {
      if (settled) return; settled = true;
      state.status = 'online';
      state.user = client.user ? client.user.tag : 'bot';
      state.error = '';
      resolve(getStatus());
    };
    // discord.js v14.18+ : événement 'clientReady' (ancien 'ready' déprécié).
    client.once('clientReady', onReady);
    client.once('ready', onReady); // compat anciennes versions
    client.on('error', e => { state.error = (e && e.message) || String(e); });

    client.login(token).catch(e => {
      if (settled) return; settled = true;
      state.status = 'error';
      state.error = 'Connexion refusée : ' + ((e && e.message) || String(e));
      resolve(getStatus());
    });

    setTimeout(() => {
      if (settled) return; settled = true;
      state.status = 'error';
      state.error = 'Délai de connexion dépassé.';
      resolve(getStatus());
    }, 15000);
  });
}

async function stop() {
  leaving = true;
  killFfmpeg();
  try { if (connection) connection.destroy(); } catch {}
  try { if (player) player.stop(true); } catch {}
  try { if (client) await client.destroy(); } catch {}
  connection = null; player = null; client = null;
  state.status = 'off'; state.error = ''; state.user = '';
  state.guildId = ''; state.guildName = '';
  state.channelId = ''; state.channelName = '';
  state.playing = false; state.nowPlaying = '';
  return getStatus();
}

/* --- Salons vocaux visibles par le bot ------------------------------------ */
function listChannels() {
  if (!client) return { guilds: [] };
  const guilds = [];
  for (const g of client.guilds.cache.values()) {
    const channels = [];
    for (const c of g.channels.cache.values()) {
      // 2 = salon vocal, 13 = salon de conférence (Stage)
      if (c.type === 2 || c.type === 13) channels.push({ id: c.id, name: c.name });
    }
    if (channels.length) guilds.push({ id: g.id, name: g.name, channels });
  }
  return { guilds };
}

/* --- Rejoindre un salon vocal --------------------------------------------- */
async function join(guildId, channelId) {
  if (!client) throw new Error('Bot non connecté.');
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Serveur introuvable (le bot y est-il invité ?).');
  const channel = guild.channels.cache.get(channelId);
  if (!channel) throw new Error('Salon vocal introuvable.');

  leaving = false;
  try { if (connection) connection.destroy(); } catch {}

  connection = Voice.joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  const conn = connection; // référence locale stable pour les handlers asynchrones

  // Logs d'état de la connexion (visibles dans le terminal du serveur).
  conn.on('stateChange', (oldS, newS) => {
    console.log('[Discord] Connexion vocale : ' + oldS.status + ' -> ' + newS.status);
  });
  conn.on('error', e => { console.error('[Discord] Erreur connexion :', e && e.message); });

  // Gestion des déconnexions : on ne reconnecte que pour une coupure réseau passagère.
  conn.on(Voice.VoiceConnectionStatus.Disconnected, async (oldS, newS) => {
    console.log('[Discord] DISCONNECTED closeCode=' + newS.closeCode + ' reason=' + newS.reason);
    // Déconnexion volontaire (bouton Déconnecter) ou exclusion/déplacement (4014) : on n'insiste pas.
    if (leaving || newS.closeCode === 4014) { try { conn.destroy(); } catch {} return; }
    // Sinon, on laisse une courte fenêtre à la reconnexion automatique.
    try {
      await Promise.race([
        Voice.entersState(conn, Voice.VoiceConnectionStatus.Signalling, 5000),
        Voice.entersState(conn, Voice.VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch { try { conn.destroy(); } catch {} }
  });

  conn.subscribe(player);

  // IMPORTANT : on attend que la connexion soit réellement "Ready" avant de jouer,
  // sinon les paquets audio partent dans le vide et on n'entend rien.
  try {
    await Voice.entersState(conn, Voice.VoiceConnectionStatus.Ready, 30000);
  } catch (e) {
    try { conn.destroy(); } catch {}
    if (connection === conn) connection = null;
    throw new Error("La connexion vocale n'a pas abouti (vérifie les permissions « Se connecter » / « Parler » sur ce salon).");
  }

  state.guildId = guildId; state.guildName = guild.name;
  state.channelId = channelId; state.channelName = channel.name;
  return getStatus();
}

/* --- Lecture -------------------------------------------------------------- */
function play(absFilePath, displayName) {
  if (!player) throw new Error('Bot non connecté.');
  if (!connection) throw new Error("Rejoignez d'abord un salon vocal.");
  console.log('[Discord] Lecture : ' + absFilePath);

  let resource;
  if (ffmpegPath) {
    // Chemin rapide : on lance FFmpeg nous-mêmes avec des options « basse
    // latence ». « -analyzeduration 0 -probesize 32 » coupe l'analyse du flux
    // que FFmpeg fait par défaut (souvent 100–200 ms), et on sort directement
    // du PCM brut 48 kHz stéréo (le format natif de Discord), ce qui évite à
    // @discordjs/voice de re-sonder/redécoder le flux. Démarrage bien plus net.
    killFfmpeg();
    ffmpegProc = spawn(ffmpegPath, [
      '-analyzeduration', '0',
      '-probesize', '32',
      '-loglevel', 'error',
      '-i', absFilePath,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    ffmpegProc.on('error', e => console.error('[Discord] FFmpeg :', e && e.message ? e.message : e));
    // Évite qu'une coupure de pipe (changement de morceau) ne fasse remonter une erreur.
    ffmpegProc.stdout.on('error', () => {});
    resource = Voice.createAudioResource(ffmpegProc.stdout, {
      inputType: Voice.StreamType.Raw,
      inlineVolume: false,
    });
  } else {
    // Repli si ffmpeg-static est absent : on laisse @discordjs/voice gérer.
    resource = Voice.createAudioResource(absFilePath, { inlineVolume: false });
  }

  player.play(resource);
  state.nowPlaying = displayName || '';
  state.playing = true;
  return getStatus();
}
function pause()  { if (player) try { player.pause(); } catch {} state.playing = false; return getStatus(); }
function resume() { if (player) try { player.unpause(); } catch {} state.playing = true; return getStatus(); }
function stopPlaying() { killFfmpeg(); if (player) try { player.stop(true); } catch {} state.playing = false; state.nowPlaying = ''; return getStatus(); }

module.exports = {
  start, stop, getStatus, listChannels, join,
  play, pause, resume, stopPlaying,
};
