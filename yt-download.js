/* ---------------------------------------------------------------------------
 *  yt-download.js — recherche + installation de morceaux depuis YouTube.
 *
 *  Objectif : zéro dépendance npm supplémentaire. On réutilise ffmpeg déjà
 *  fourni par le paquet "ffmpeg-static" (présent dans package.json), et on
 *  récupère automatiquement le binaire standalone "yt-dlp" depuis GitHub la
 *  première fois qu'on en a besoin. L'utilisateur n'a donc rien à installer.
 *
 *  Exporte :
 *    search(query, limit)            -> Promise<[{id,title,channel,duration,thumb}]>
 *    startDownload(id, title, dir)   -> jobId (string), télécharge en arrière-plan
 *    getProgress(jobId)              -> { status, percent, title, file, error }
 *    isReady() / ensureYtDlp()       -> état / amorçage du binaire yt-dlp
 * ------------------------------------------------------------------------- */

const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Chemin du binaire ffmpeg fourni par ffmpeg-static (déjà une dépendance).
let ffmpegPath = '';
try { ffmpegPath = require('ffmpeg-static') || ''; } catch { ffmpegPath = ''; }

const isWin = process.platform === 'win32';
const BIN_DIR = path.join(__dirname, 'bin');
const LOCAL_YTDLP = path.join(BIN_DIR, isWin ? 'yt-dlp.exe' : 'yt-dlp');

// Nom de l'asset standalone (sans dépendance Python) selon la plateforme.
function ytdlpAssetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp_linux';
}

/* ------------------------- téléchargement HTTP simple ---------------------- */
function httpDownload(url, dest, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Trop de redirections'));
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'Spotafy-Local' } }, res => {
      // GitHub renvoie une redirection 302 vers le CDN qui héberge le binaire.
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        file.close(() => { fs.unlink(dest, () => {}); httpDownload(res.headers.location, dest, redirects + 1).then(resolve, reject); });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close(() => { fs.unlink(dest, () => {}); });
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', err => { file.close(() => { fs.unlink(dest, () => {}); }); reject(err); });
  });
}

// Petite requête GET qui renvoie du JSON (utilisée pour l'API de paroles LRCLIB).
function httpGetJson(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Trop de redirections'));
    const req = https.get(url, { headers: { 'User-Agent': 'Spotafy-Local/1.0 (lecteur de musique local)' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return httpGetJson(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 4e6) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(6000, () => req.destroy(new Error('Délai dépassé')));
    req.on('error', reject);
  });
}

// Nettoie un titre YouTube pour améliorer la recherche de paroles
// (enlève « (Official Video) », « [HD] », « (Lyrics) », etc.).
function cleanTitle(t) {
  return String(t || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:official|lyrics?|audio|video|visualizer|mv|hd|4k|m\/?v|clip officiel)[^)]*\)/ig, ' ')
    .replace(/\b(official\s+(?:music\s+)?video|official\s+audio|lyric\s+video|visualizer|clip officiel)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cherche des paroles synchronisées sur LRCLIB et les enregistre en .lrc (ou en
// .txt si seules des paroles non synchronisées existent), à côté du morceau.
// Best-effort : en cas d'échec ou d'absence de résultat, on ne fait rien.
function fetchAndSaveLyrics(audioPath, title) {
  try {
    if (!audioPath) return;
    const q = cleanTitle(title) || path.basename(audioPath, path.extname(audioPath));
    if (!q) return;
    const url = 'https://lrclib.net/api/search?q=' + encodeURIComponent(q);
    httpGetJson(url).then(arr => {
      if (!Array.isArray(arr) || !arr.length) return;
      const synced = arr.find(x => x && typeof x.syncedLyrics === 'string' && x.syncedLyrics.trim());
      const plain = arr.find(x => x && typeof x.plainLyrics === 'string' && x.plainLyrics.trim());
      const dir = path.dirname(audioPath);
      const base = path.basename(audioPath, path.extname(audioPath));
      if (synced) { try { fs.writeFileSync(path.join(dir, base + '.lrc'), synced.syncedLyrics, 'utf8'); } catch {} }
      else if (plain) { try { fs.writeFileSync(path.join(dir, base + '.txt'), plain.plainLyrics, 'utf8'); } catch {} }
    }).catch(() => {});
  } catch {}
}

/* ------------------------- résolution du binaire yt-dlp -------------------- */
// yt-dlp est-il accessible dans le PATH du système ?
function tryPathYtDlp() {
  return new Promise(resolve => {
    const cmd = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    let p;
    try { p = spawn(cmd, ['--version']); } catch { return resolve(null); }
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? cmd : null));
  });
}

let ensurePromise = null;     // mémorise l'amorçage en cours / réussi
let readyBin = '';            // chemin/commande du binaire prêt à l'emploi

function ensureYtDlp() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    // 1) binaire déjà téléchargé localement
    if (fs.existsSync(LOCAL_YTDLP)) { readyBin = LOCAL_YTDLP; return readyBin; }
    // 2) yt-dlp déjà installé sur la machine (PATH)
    const onPath = await tryPathYtDlp();
    if (onPath) { readyBin = onPath; return readyBin; }
    // 3) sinon, on le récupère automatiquement depuis GitHub
    try { fs.mkdirSync(BIN_DIR, { recursive: true }); } catch {}
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + ytdlpAssetName();
    await httpDownload(url, LOCAL_YTDLP);
    if (!isWin) { try { fs.chmodSync(LOCAL_YTDLP, 0o755); } catch {} }
    readyBin = LOCAL_YTDLP;
    return readyBin;
  })().catch(e => { ensurePromise = null; throw e; });
  return ensurePromise;
}

function isReady() { return !!readyBin; }

/* --------------------------------- recherche ------------------------------- */
function search(query, limit) {
  limit = Math.max(1, Math.min(15, limit || 8));
  return ensureYtDlp().then(bin => new Promise((resolve, reject) => {
    const args = [
      'ytsearch' + limit + ':' + query,
      '--flat-playlist', '--dump-json',
      '--no-warnings', '--no-call-home', '--ignore-errors'
    ];
    const p = spawn(bin, args);
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0 && !out.trim()) return reject(new Error((err.trim().split('\n').pop()) || 'Recherche échouée'));
      const items = [];
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (!j.id) continue;
          items.push({
            id: j.id,
            title: j.title || '(sans titre)',
            channel: j.channel || j.uploader || j.playlist_uploader || '',
            duration: j.duration || 0,
            // Vignette fiable construite à partir de l'id (toujours disponible).
            thumb: 'https://i.ytimg.com/vi/' + j.id + '/mqdefault.jpg'
          });
        } catch {}
      }
      resolve(items);
    });
  }));
}

/* ------------------------------- téléchargement ---------------------------- */
const jobs = new Map(); // jobId -> { status, percent, title, file, error }

function genJob() { return 'j_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function startDownload(videoId, title, songDir) {
  const jobId = genJob();
  const job = { status: 'starting', percent: 0, title: title || '', file: '', error: '' };
  jobs.set(jobId, job);

  ensureYtDlp().then(bin => {
    const url = 'https://www.youtube.com/watch?v=' + videoId;
    const outTmpl = path.join(songDir, '%(title)s.%(ext)s');

    // Téléchargement direct de la MEILLEURE piste audio, telle quelle, SANS
    // conversion ni post-traitement : un seul fichier (souvent .webm/opus ou
    // .m4a) atterrit directement dans /song. Pas de ffmpeg, pas de dossier
    // temporaire, pas de .temp.mp3 — donc rien qui puisse échouer côté conversion.
    // Pendant le téléchargement, yt-dlp écrit dans un ".part" (ignoré par
    // l'appli) ; le fichier final n'apparaît qu'une fois le téléchargement
    // terminé, en une seule fois.
    const args = [
      url,
      '-f', 'bestaudio/best',
      '--write-thumbnail',
      '--no-playlist', '--newline', '--no-warnings',
      '-o', outTmpl
    ];

    let p;
    try { p = spawn(bin, args); }
    catch (e) { job.status = 'error'; job.error = e.message; return; }

    job.status = 'downloading';
    let errBuf = '';

    const onLine = line => {
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m) { job.percent = parseFloat(m[1]); job.status = 'downloading'; }
      const dest = line.match(/\[download\]\s+Destination:\s*(.+?)\s*$/);
      if (dest && !/\.(jpe?g|png|webp|gif)$/i.test(dest[1])) job.file = dest[1];
      const already = line.match(/\[download\]\s+(.+?) has already been downloaded/);
      if (already && !/\.(jpe?g|png|webp|gif)$/i.test(already[1])) job.file = already[1];
    };
    const feed = chunk => { for (const line of chunk.toString().split(/\r?\n/)) onLine(line); };

    p.stdout.on('data', feed);
    p.stderr.on('data', d => { errBuf += d.toString(); feed(d); });
    p.on('error', e => { job.status = 'error'; job.error = e.message; });
    p.on('close', code => {
      if (code === 0) {
        job.status = 'done'; job.percent = 100;
        // Récupère les paroles synchronisées en arrière-plan (n'empêche jamais
        // l'installation de réussir, même si LRCLIB ne trouve rien).
        fetchAndSaveLyrics(job.file, title);
      }
      else { job.status = 'error'; job.error = (errBuf.trim().split('\n').pop()) || ('yt-dlp a quitté (' + code + ')'); }
    });
  }).catch(e => { job.status = 'error'; job.error = e.message; });

  // Nettoyage automatique des vieux jobs après 10 min.
  setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  return jobId;
}

function getProgress(jobId) {
  return jobs.get(jobId) || { status: 'error', error: 'Tâche introuvable', percent: 0 };
}

module.exports = { search, startDownload, getProgress, ensureYtDlp, isReady };
