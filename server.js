const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const SONG_DIR = path.join(__dirname, 'song');
const AUDIO_EXTS = new Set(['.mp3','.wav','.ogg','.flac','.aac','.m4a','.wma','.opus']);
const VIDEO_EXTS = new Set(['.mp4','.mov','.m4v','.webm','.mkv']);

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
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.flac':'audio/flac',
  '.aac':'audio/aac','.m4a':'audio/mp4','.wma':'audio/x-ms-wma','.opus':'audio/opus',
  '.mp4':'video/mp4','.mov':'video/quicktime','.m4v':'video/x-m4v','.webm':'video/webm','.mkv':'video/x-matroska',
  '.html':'text/html','.js':'application/javascript','.css':'text/css'
};

const server = http.createServer((req, res) => {
  if (req.url === '/api/songs') {
    const songs = scanDir(SONG_DIR, SONG_DIR);
    res.writeHead(200, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' });
    res.end(JSON.stringify(songs));
    return;
  }

  if (req.url.startsWith('/song/')) {
    const filePath = path.join(__dirname, decodeURIComponent(req.url));
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace('bytes=','').split('-');
      const start = parseInt(startStr);
      const end = endStr ? parseInt(endStr) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // Serve index.html
  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Spotafy Local running at ${url}`);
  // Auto-open browser
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
});
