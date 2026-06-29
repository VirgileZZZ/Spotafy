const http = require('http');
const fs = require('fs');
const path = require('path');

// Module bot Discord (optionnel). Il charge ses propres dépendances de façon
// paresseuse : son simple require ne plante jamais, même sans npm install.
let discord = null;
try { discord = require('./discord-bot'); } catch { discord = null; }

// Module d'ajout de sons (recherche + téléchargement YouTube). Chargé de façon
// paresseuse et tolérante : son require ne plante jamais le serveur.
let yt = null;
try { yt = require('./yt-download'); } catch { yt = null; }

const PORT = 3000;
const SONG_DIR = path.join(__dirname, 'song');
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.opus']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

// Make sure the song folder exists so first run never crashes.
try { if (!fs.existsSync(SONG_DIR)) fs.mkdirSync(SONG_DIR, { recursive: true }); } catch {}

/* ---------------------------------------------------------------------------
 *  Persistance : favoris + playlists personnalisées dans library.json
 * ------------------------------------------------------------------------- */
const LIBRARY_FILE = path.join(__dirname, 'library.json');
let library = { likes: [], playlists: [] };

function loadLibrary() {
  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      const d = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
      library.likes = Array.isArray(d.likes) ? [...new Set(d.likes)] : [];
      library.playlists = Array.isArray(d.playlists) ? d.playlists.map(p => ({
        id: p.id || genId(), name: String(p.name || 'Playlist'),
        paths: Array.isArray(p.paths) ? [...new Set(p.paths)] : []
      })) : [];
    }
  } catch { library = { likes: [], playlists: [] }; }
}
function saveLibrary() { try { fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2)); } catch {} }
function genId() { return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function setLike(p, liked) {
  const set = new Set(library.likes);
  if (liked) set.add(p); else set.delete(p);
  library.likes = [...set];
  saveLibrary();
}
function handlePlaylistAction(b) {
  const find = id => library.playlists.find(p => p.id === id);
  switch (b.action) {
    case 'create': {
      const pl = { id: genId(), name: String(b.name || 'Nouvelle playlist').slice(0, 80), paths: [] };
      library.playlists.push(pl); break;
    }
    case 'rename': { const p = find(b.id); if (p && b.name) p.name = String(b.name).slice(0, 80); break; }
    case 'delete': { library.playlists = library.playlists.filter(p => p.id !== b.id); break; }
    case 'add': { const p = find(b.id); if (p && b.path && !p.paths.includes(b.path)) p.paths.push(b.path); break; }
    case 'remove': { const p = find(b.id); if (p) p.paths = p.paths.filter(x => x !== b.path); break; }
    case 'setpaths': { const p = find(b.id); if (p && Array.isArray(b.paths)) p.paths = [...new Set(b.paths)]; break; }
  }
  saveLibrary();
}

// Signature légère pour détecter l'ajout/suppression de fichiers (polling client).
function librarySignature() {
  const files = scanDir(SONG_DIR, SONG_DIR);
  let acc = 0;
  for (const f of files) { try { const st = fs.statSync(path.join(SONG_DIR, f.path)); acc += st.size + Math.floor(st.mtimeMs); } catch {} }
  return files.length + '-' + acc;
}

function decodeBufferText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const b = Buffer.from(buf); for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
    return b.toString('utf16le').replace(/^\uFEFF/, '');
  }
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  if (s.includes('\uFFFD')) s = buf.toString('latin1'); // UTF-8 invalide -> repli latin1 (Windows-1252)
  return s;
}

function scanDir(dir, base) {
  let results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(scanDir(full, base));
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
          const rel = path.relative(base, full).replace(/\\/g, '/');
          const folder = path.dirname(rel) === '.' ? '' : path.dirname(rel);
          results.push({
            name: path.basename(entry.name, ext),
            path: rel,
            folder: folder
          });
        }
      }
    }
  } catch {}
  return results;
}

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.wma': 'audio/x-ms-wma', '.opus': 'audio/opus',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css'
};

/* ---------------------------------------------------------------------------
 *  Metadata extraction — zero dependencies, best effort.
 *  Supports: MP3 (ID3v2.2/2.3/2.4), FLAC (Vorbis comment + picture),
 *  M4A/MP4/M4V (iTunes atoms), OGG/Opus (Vorbis comment, text only).
 *  Always wrapped in try/catch: a parse failure must never break a file.
 * ------------------------------------------------------------------------- */

const metaCache = new Map(); // key: absPath|mtime|size -> { title, artist, album, year, hasCover, cover:{mime,data} }

function cacheKey(absPath) {
  try {
    const st = fs.statSync(absPath);
    return `${absPath}|${st.mtimeMs}|${st.size}`;
  } catch {
    return absPath;
  }
}

function parseAny(absPath, opts) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.mp3') return parseID3(absPath, opts);
  if (ext === '.flac') return parseFlac(absPath, opts);
  if (ext === '.m4a' || ext === '.mp4' || ext === '.m4v' || ext === '.aac') return parseMp4(absPath, opts);
  if (ext === '.ogg' || ext === '.opus') return parseOgg(absPath, opts);
  return { title: '', artist: '', album: '', year: '', hasCover: false, cover: null, lyrics: '' };
}

function getMetadata(absPath) {
  const key = cacheKey(absPath);
  if (metaCache.has(key)) return metaCache.get(key);
  let meta = { title: '', artist: '', album: '', year: '', hasCover: false, cover: null };
  try { meta = parseAny(absPath, {}); }
  catch { meta = { title: '', artist: '', album: '', year: '', hasCover: false, cover: null }; }
  // Keep memory reasonable: don't cache the raw cover bytes, only the fact + mime.
  const light = { title: meta.title, artist: meta.artist, album: meta.album, year: meta.year, hasCover: meta.hasCover, coverMime: meta.cover ? meta.cover.mime : '' };
  metaCache.set(key, light);
  return light;
}

function getCover(absPath) {
  try {
    const ext = path.extname(absPath).toLowerCase();
    if (!['.mp3', '.flac', '.m4a', '.mp4', '.m4v', '.aac'].includes(ext)) return null;
    const meta = parseAny(absPath, { wantCover: true });
    return meta && meta.cover ? meta.cover : null;
  } catch { return null; }
}

// Image "sidecar" (téléchargée à côté du morceau, ex. miniature de la vidéo) :
// <base>.jpg / .jpeg / .png / .webp dans le même dossier que le fichier audio.
const SIDECAR_IMG = [['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']];
function sidecarImage(absPath) {
  try {
    const dir = path.dirname(absPath);
    const base = path.basename(absPath, path.extname(absPath));
    for (const [e, mime] of SIDECAR_IMG) {
      const p = path.join(dir, base + e);
      if (fs.existsSync(p)) return { path: p, mime };
    }
  } catch {}
  return null;
}
function hasSidecarImage(absPath) { return !!sidecarImage(absPath); }

// Sidecar .lrc/.txt next to the audio file takes priority; otherwise embedded lyrics.
function getLyrics(absPath) {
  try {
    const dir = path.dirname(absPath);
    const base = path.basename(absPath, path.extname(absPath));
    for (const e of ['.lrc', '.txt']) {
      const p = path.join(dir, base + e);
      if (fs.existsSync(p)) {
        const text = decodeBufferText(fs.readFileSync(p));
        return { synced: /\[\d{1,2}:\d{2}/.test(text), text };
      }
    }
  } catch {}
  try {
    const meta = parseAny(absPath, { wantLyrics: true });
    if (meta && meta.lyrics) return { synced: /\[\d{1,2}:\d{2}/.test(meta.lyrics), text: meta.lyrics };
  } catch {}
  return { synced: false, text: '' };
}

// --- text decoding helpers ---
function decodeText(buf, encoding) {
  try {
    if (encoding === 0) return buf.toString('latin1').replace(/\0+$/, '');
    if (encoding === 3) return buf.toString('utf8').replace(/\0+$/, '');
    // UTF-16 with or without BOM
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le').replace(/\0+$/, '');
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return swap16(buf.slice(2)).toString('utf16le').replace(/\0+$/, '');
    return buf.toString('utf16le').replace(/\0+$/, '');
  } catch { return ''; }
}
function swap16(buf) { const b = Buffer.from(buf); for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; } return b; }

// --- MP3 / ID3v2 ---
function parseID3(absPath, opts) {
  opts = opts || {};
  const out = { title: '', artist: '', album: '', year: '', hasCover: false, cover: null, lyrics: '' };
  const fd = fs.openSync(absPath, 'r');
  try {
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) !== 'ID3') return out;
    const version = head[3];
    const flags = head[5];
    const size = synchsafe(head.readUInt32BE(6));
    let body = Buffer.alloc(size);
    fs.readSync(fd, body, 0, size, 10);
    if (flags & 0x80) body = deUnsync(body); // global unsynchronisation
    let pos = 0;
    // skip extended header
    if (flags & 0x40 && version >= 3) {
      const extSize = version === 4 ? synchsafe(body.readUInt32BE(0)) : body.readUInt32BE(0) + 4;
      pos += extSize;
    }
    const idLen = version === 2 ? 3 : 4;
    const sizeLen = version === 2 ? 3 : 4;
    const headerLen = version === 2 ? 6 : 10;
    while (pos + headerLen <= body.length) {
      const id = body.toString('latin1', pos, pos + idLen);
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding / end
      let frameSize;
      if (version === 2) frameSize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
      else if (version === 4) frameSize = synchsafe(body.readUInt32BE(pos + 4));
      else frameSize = body.readUInt32BE(pos + 4);
      const dataStart = pos + headerLen;
      if (frameSize <= 0 || dataStart + frameSize > body.length) break;
      const frame = body.slice(dataStart, dataStart + frameSize);

      if (id === 'TIT2' || id === 'TT2') out.title = readTextFrame(frame);
      else if (id === 'TPE1' || id === 'TP1') out.artist = readTextFrame(frame);
      else if (id === 'TALB' || id === 'TAL') out.album = readTextFrame(frame);
      else if (id === 'TYER' || id === 'TYE' || id === 'TDRC') out.year = readTextFrame(frame).slice(0, 4);
      else if ((id === 'APIC' || id === 'PIC')) {
        out.hasCover = true;
        if (opts.wantCover && !out.cover) out.cover = readPicFrame(frame, id);
      }
      else if ((id === 'USLT' || id === 'ULT') && opts.wantLyrics && !out.lyrics) {
        out.lyrics = readUsltFrame(frame);
      }
      pos = dataStart + frameSize;
    }
  } finally { fs.closeSync(fd); }
  return out;
}
function synchsafe(n) { return ((n & 0x7f000000) >> 3) | ((n & 0x7f0000) >> 2) | ((n & 0x7f00) >> 1) | (n & 0x7f); }
function deUnsync(buf) {
  const out = []; for (let i = 0; i < buf.length; i++) { out.push(buf[i]); if (buf[i] === 0xFF && buf[i + 1] === 0x00) i++; }
  return Buffer.from(out);
}
function readTextFrame(frame) {
  if (frame.length < 1) return '';
  return decodeText(frame.slice(1), frame[0]);
}
function readUsltFrame(frame) {
  try {
    if (frame.length < 5) return '';
    const enc = frame[0];
    let p = 4; // 1 enc + 3 language
    // skip content descriptor (null-terminated in the encoding)
    if (enc === 1 || enc === 2) { while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2; p += 2; }
    else { while (p < frame.length && frame[p] !== 0) p++; p += 1; }
    return decodeText(frame.slice(p), enc);
  } catch { return ''; }
}
function readPicFrame(frame, id) {
  try {
    let p = 0;
    const enc = frame[p++];
    let mime;
    if (id === 'PIC') { // v2.2: 3-char format
      const fmt = frame.toString('latin1', p, p + 3).toLowerCase(); p += 3;
      mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    } else {
      let end = p; while (end < frame.length && frame[end] !== 0) end++;
      mime = frame.toString('latin1', p, end) || 'image/jpeg'; p = end + 1;
    }
    p += 1; // picture type byte
    // description, terminated by null in the text encoding
    if (enc === 1 || enc === 2) { while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2; p += 2; }
    else { while (p < frame.length && frame[p] !== 0) p++; p += 1; }
    const data = frame.slice(p);
    if (!data.length) return null;
    return { mime, data };
  } catch { return null; }
}

// --- FLAC ---
function parseFlac(absPath, opts) {
  opts = opts || {};
  const out = { title: '', artist: '', album: '', year: '', hasCover: false, cover: null, lyrics: '' };
  const fd = fs.openSync(absPath, 'r');
  try {
    const magic = Buffer.alloc(4); fs.readSync(fd, magic, 0, 4, 0);
    if (magic.toString('latin1') !== 'fLaC') return out;
    let offset = 4, last = false, guard = 0;
    while (!last && guard++ < 64) {
      const bh = Buffer.alloc(4); fs.readSync(fd, bh, 0, 4, offset);
      last = (bh[0] & 0x80) !== 0;
      const type = bh[0] & 0x7f;
      const len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
      const blockStart = offset + 4;
      if (type === 4) { // VORBIS_COMMENT
        const block = Buffer.alloc(len); fs.readSync(fd, block, 0, len, blockStart);
        parseVorbisComment(block, out);
      } else if (type === 6) { // PICTURE
        out.hasCover = true;
        if (opts.wantCover && !out.cover) {
          const block = Buffer.alloc(len); fs.readSync(fd, block, 0, len, blockStart);
          out.cover = parseFlacPicture(block);
        }
      }
      offset = blockStart + len;
    }
  } finally { fs.closeSync(fd); }
  return out;
}
function parseVorbisComment(block, out) {
  let p = 0;
  const vlen = block.readUInt32LE(p); p += 4 + vlen;
  const count = block.readUInt32LE(p); p += 4;
  for (let i = 0; i < count && p + 4 <= block.length; i++) {
    const clen = block.readUInt32LE(p); p += 4;
    const c = block.toString('utf8', p, p + clen); p += clen;
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    const k = c.slice(0, eq).toUpperCase(), v = c.slice(eq + 1);
    if (k === 'TITLE' && !out.title) out.title = v;
    else if (k === 'ARTIST' && !out.artist) out.artist = v;
    else if (k === 'ALBUM' && !out.album) out.album = v;
    else if ((k === 'DATE' || k === 'YEAR') && !out.year) out.year = v.slice(0, 4);
    else if ((k === 'LYRICS' || k === 'UNSYNCEDLYRICS' || k === 'SYNCEDLYRICS') && !out.lyrics) out.lyrics = v;
  }
}
function parseFlacPicture(block) {
  try {
    let p = 4; // picture type (u32 BE)
    const mlen = block.readUInt32BE(p); p += 4;
    const mime = block.toString('latin1', p, p + mlen); p += mlen;
    const dlen = block.readUInt32BE(p); p += 4 + dlen; // description
    p += 16; // width,height,depth,colors (4 x u32)
    const len = block.readUInt32BE(p); p += 4;
    const data = block.slice(p, p + len);
    return data.length ? { mime: mime || 'image/jpeg', data } : null;
  } catch { return null; }
}

// --- MP4 / M4A (iTunes atoms) ---
function parseMp4(absPath, opts) {
  opts = opts || {};
  const out = { title: '', artist: '', album: '', year: '', hasCover: false, cover: null, lyrics: '' };
  const fd = fs.openSync(absPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const moov = findAtom(fd, 0, fileSize, 'moov');
    if (!moov) return out;
    const buf = Buffer.alloc(Math.min(moov.size, 8 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, moov.start);
    const ilst = findAtomInBuf(buf, 0, buf.length, ['udta', 'meta', 'ilst']);
    if (!ilst) return out;
    walkIlst(buf, ilst.start, ilst.end, out, opts);
  } finally { fs.closeSync(fd); }
  return out;
}
function findAtom(fd, start, end, name) {
  let pos = start, guard = 0;
  const h = Buffer.alloc(8);
  while (pos + 8 <= end && guard++ < 1000) {
    fs.readSync(fd, h, 0, 8, pos);
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) { const ext = Buffer.alloc(8); fs.readSync(fd, ext, 0, 8, pos + 8); size = Number(ext.readBigUInt64BE(0)); headerSize = 16; }
    if (size < headerSize) break;
    if (type === name) return { start: pos + headerSize, size: size - headerSize };
    pos += size;
  }
  return null;
}
function findAtomInBuf(buf, start, end, namePath) {
  let curStart = start, curEnd = end;
  for (let depth = 0; depth < namePath.length; depth++) {
    const name = namePath[depth];
    let pos = curStart, found = null;
    // 'meta' is a full box: skip 4 bytes (version+flags) after its header before children
    while (pos + 8 <= curEnd) {
      const size = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      if (size < 8 || pos + size > curEnd + 8) break;
      if (type === name) { found = { start: pos + 8, end: pos + size }; break; }
      pos += size;
    }
    if (!found) return null;
    let childStart = found.start;
    if (name === 'meta') childStart += 4; // version+flags
    curStart = childStart; curEnd = found.end;
  }
  return { start: curStart, end: curEnd };
}
function walkIlst(buf, start, end, out, opts) {
  opts = opts || {};
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size < 8 || pos + size > end) break;
    // each item contains a 'data' atom
    const dataAtomPos = pos + 8;
    if (dataAtomPos + 16 <= pos + size) {
      const dSize = buf.readUInt32BE(dataAtomPos);
      const dType = buf.toString('latin1', dataAtomPos + 4, dataAtomPos + 8);
      if (dType === 'data') {
        const flags = buf.readUInt32BE(dataAtomPos + 8) & 0xffffff;
        const payload = buf.slice(dataAtomPos + 16, dataAtomPos + dSize);
        if (type === '\u00A9nam') out.title = payload.toString('utf8');
        else if (type === '\u00A9ART' || type === 'aART') out.artist = out.artist || payload.toString('utf8');
        else if (type === '\u00A9alb') out.album = payload.toString('utf8');
        else if (type === '\u00A9day') out.year = payload.toString('utf8').slice(0, 4);
        else if (type === '\u00A9lyr') { if (opts.wantLyrics) out.lyrics = payload.toString('utf8'); }
        else if (type === 'covr') {
          out.hasCover = true;
          if (opts.wantCover && !out.cover) out.cover = { mime: flags === 14 ? 'image/png' : 'image/jpeg', data: Buffer.from(payload) };
        }
      }
    }
    pos += size;
  }
}

// --- OGG / Opus (text only, best effort) ---
function parseOgg(absPath, opts) {
  opts = opts || {};
  const out = { title: '', artist: '', album: '', year: '', hasCover: false, cover: null, lyrics: '' };
  const fd = fs.openSync(absPath, 'r');
  try {
    const len = Math.min(fs.fstatSync(fd).size, 256 * 1024);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, 0);
    let idx = buf.indexOf('vorbis', 0, 'latin1');
    // comment header packet starts with 0x03 'vorbis'
    let commentIdx = -1;
    let scan = 0;
    while ((scan = buf.indexOf(Buffer.from([0x03]), scan)) !== -1) {
      if (buf.toString('latin1', scan + 1, scan + 7) === 'vorbis') { commentIdx = scan + 7; break; }
      scan++;
    }
    if (commentIdx === -1) {
      const opus = buf.indexOf('OpusTags', 0, 'latin1');
      if (opus !== -1) commentIdx = opus + 8;
    }
    if (commentIdx !== -1) parseVorbisComment(buf.slice(commentIdx), out);
  } catch {} finally { fs.closeSync(fd); }
  return out;
}

/* ------------------------------- server ---------------------------------- */

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) b = b.slice(0, 1e6); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/* Cache de la bibliothèque : on ne rescanne et ne relit les métadonnées que
 * lorsqu'un fichier change réellement (détecté par fs.watch). Évite de bloquer
 * le serveur à chaque chargement / sondage, surtout avec plusieurs appareils. */
let songsCache = null, libVersion = 1, watchOk = false, watchTimer = null;
function buildSongs() {
  return scanDir(SONG_DIR, SONG_DIR).map(s => {
    const abs = path.join(SONG_DIR, s.path);
    const m = getMetadata(abs);
    return {
      name: s.name, path: s.path, folder: s.folder,
      title: m.title || '', artist: m.artist || '', album: m.album || '', year: m.year || '',
      hasCover: !!m.hasCover || hasSidecarImage(abs)
    };
  });
}
function getSongs() {
  if (watchOk && songsCache) return songsCache;   // cache fiable seulement si fs.watch fonctionne
  songsCache = buildSongs();
  return songsCache;
}
function getVersion() {
  return watchOk ? 'v' + libVersion : librarySignature(); // compteur léger, sinon repli par scan
}
function invalidateLibrary() { songsCache = null; metaCache.clear(); libVersion++; }

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (req.url === '/api/library') { sendJson(res, library); return; }
  if (req.url === '/api/version') { sendJson(res, { sig: getVersion() }); return; }

  // Vide le cache serveur (liste des morceaux + métadonnées ID3/cover) et force un
  // rescan complet du dossier au prochain /api/songs. Appelé par le bouton "Actualiser".
  if (req.method === 'POST' && req.url === '/api/refresh') {
    invalidateLibrary();
    sendJson(res, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/like') {
    const b = await readBody(req);
    if (b.path) setLike(b.path, !!b.liked);
    sendJson(res, { ok: true, likes: library.likes });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/playlists') {
    const b = await readBody(req);
    handlePlaylistAction(b);
    sendJson(res, { ok: true, playlists: library.playlists });
    return;
  }

  if (req.url === '/api/songs') {
    sendJson(res, getSongs());
    return;
  }

  /* ----------------------- Pilotage du bot Discord ----------------------- */
  if (req.url.startsWith('/api/discord')) {
    if (!discord) { sendJson(res, { status: 'error', error: 'Module Discord absent.', hasDeps: false }); return; }
    try {
      if (req.url === '/api/discord/status') { sendJson(res, discord.getStatus()); return; }
      if (req.url === '/api/discord/channels') { sendJson(res, discord.listChannels()); return; }

      if (req.method === 'POST' && req.url === '/api/discord/start') {
        const b = await readBody(req);
        sendJson(res, await discord.start(b.token));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/discord/stop') {
        sendJson(res, await discord.stop());
        return;
      }
      if (req.method === 'POST' && req.url === '/api/discord/join') {
        const b = await readBody(req);
        sendJson(res, await discord.join(b.guildId, b.channelId));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/discord/play') {
        const b = await readBody(req);
        // Sécurité : on n'autorise que les fichiers du dossier /song.
        const rel = String(b.path || '').replace(/^\/+/, '');
        const filePath = path.join(SONG_DIR, rel);
        if (!filePath.startsWith(SONG_DIR) || !fs.existsSync(filePath)) {
          sendJson(res, { status: 'error', error: 'Fichier introuvable.' }); return;
        }
        sendJson(res, discord.play(filePath, b.name || path.basename(rel)));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/discord/pause')  { sendJson(res, discord.pause()); return; }
      if (req.method === 'POST' && req.url === '/api/discord/resume') { sendJson(res, discord.resume()); return; }
      if (req.method === 'POST' && req.url === '/api/discord/skip')   { sendJson(res, discord.stopPlaying()); return; }
    } catch (e) {
      sendJson(res, { status: 'error', error: (e && e.message) || String(e) });
      return;
    }
  }

  /* ------------------- Ajout de sons (recherche + install) --------------- */
  if (req.url.startsWith('/api/yt/search')) {
    if (!yt) { sendJson(res, { error: 'Module d\'ajout de sons indisponible.' }); return; }
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
    if (!q) { sendJson(res, []); return; }
    try { sendJson(res, await yt.search(q, 8)); }
    catch (e) { sendJson(res, { error: (e && e.message) || String(e) }); }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/yt/download') {
    if (!yt) { sendJson(res, { error: 'Module d\'ajout de sons indisponible.' }); return; }
    const b = await readBody(req);
    if (!b.id) { sendJson(res, { error: 'Identifiant manquant.' }); return; }
    const jobId = yt.startDownload(String(b.id), String(b.title || ''), SONG_DIR);
    sendJson(res, { jobId });
    return;
  }
  if (req.url.startsWith('/api/yt/progress')) {
    if (!yt) { sendJson(res, { status: 'error', error: 'Module indisponible.', percent: 0 }); return; }
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    sendJson(res, yt.getProgress(id));
    return;
  }

  if (url.startsWith('/cover/')) {
    const rel = url.slice('/cover/'.length);
    const filePath = path.join(SONG_DIR, rel);
    if (!filePath.startsWith(SONG_DIR) || !fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    const cover = getCover(filePath);
    if (cover) {
      res.writeHead(200, { 'Content-Type': cover.mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(cover.data);
      return;
    }
    // Repli : image téléchargée à côté du morceau (miniature de la vidéo).
    const side = sidecarImage(filePath);
    if (side) {
      res.writeHead(200, { 'Content-Type': side.mime, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(side.path).pipe(res);
      return;
    }
    res.writeHead(404); res.end();
    return;
  }

  if (url.startsWith('/lyrics/')) {
    const rel = url.slice('/lyrics/'.length);
    const filePath = path.join(SONG_DIR, rel);
    if (!filePath.startsWith(SONG_DIR) || !fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    const lyr = getLyrics(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(lyr));
    return;
  }

  if (url.startsWith('/song/')) {
    const filePath = path.join(__dirname, url);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const range = req.headers.range;

    // Fichier vide (0 octet) : on répond proprement au lieu de calculer une plage -1.
    if (size === 0) {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': 0, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }

    const onStreamErr = () => { try { res.destroy(); } catch {} };

    if (range && /bytes=/.test(range)) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] === '' || m[1] === undefined ? 0 : parseInt(m[1], 10);
      let end = m[2] === '' || m[2] === undefined ? size - 1 : parseInt(m[2], 10);
      // Bornes robustes : on évite tout NaN / valeur hors plage qui ferait planter le flux.
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) { // plage impossible -> 416
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime
      });
      fs.createReadStream(filePath, { start, end }).on('error', onStreamErr).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).on('error', onStreamErr).pipe(res);
    }
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

loadLibrary();

// Message clair si le démarrage échoue (cause la plus fréquente : le port 3000
// est déjà pris parce qu'une autre fenêtre Spotafy Local tourne encore).
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n[ERREUR] Le port ${PORT} est déjà utilisé.`);
    console.error('Spotafy Local tourne probablement déjà dans une autre fenêtre.');
    console.error('Ferme l\'autre fenêtre noire (ou utilise l\'onglet déjà ouvert), puis relance.');
  } else {
    console.error('\n[ERREUR] Impossible de démarrer le serveur :', (e && e.message) || e);
  }
  process.exitCode = 1;
});

// Évite que le programme se ferme sans rien dire sur une erreur imprévue.
process.on('uncaughtException', (e) => {
  console.error('\n[ERREUR] Problème inattendu :', (e && e.message) || e);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  let count = 0;
  try { count = scanDir(SONG_DIR, SONG_DIR).length; } catch {}
  console.log(`Spotafy Local running at ${url}`);
  console.log(`Bibliothèque : ${count} fichier(s) détecté(s) dans /song`);
  console.log(`Favoris : ${library.likes.length} · Playlists : ${library.playlists.length}`);
  // Surveillance du dossier : invalide le cache uniquement quand un fichier change.
  try {
    fs.watch(SONG_DIR, { recursive: true }, () => {
      clearTimeout(watchTimer); watchTimer = setTimeout(invalidateLibrary, 300);
    });
    watchOk = true;
  } catch { watchOk = false; /* recursif non supporté : repli par scan via /api/version */ }
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
});