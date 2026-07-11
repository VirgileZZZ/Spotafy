# Spotafy Local

A self-hosted, **zero-dependency** music player with a Spotify-inspired interface. It scans a folder of your own audio/video files, reads their embedded metadata and cover art, and serves a polished web player you can use from any device on your local network — desktop, Android, or iPhone.

No accounts, no streaming, no internet required, no `npm install`. Just Node.js and your files.

> **Credits.** The advanced version documented here — server-side favorites and playlists, embedded-metadata and cover-art parsing, synced `.lrc` lyrics, advanced loudness normalization, the equalizer, the iPhone background-playback mode, the full mobile UI, drag-and-drop, and automatic library detection. It builds on the original "Spotafy Local" scaffold (a Spotify-style folder player by Mimo 2.5 , Opus 4.8 and Hy3 / OpenCode ). The application remains a single `server.js` plus a single `index.html`, with **no third-party packages**.

---

## Table of contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Adding your music](#adding-your-music)
- [Using it on your phone (iPhone / Android)](#using-it-on-your-phone-iphone--android)
- [Install as an app on your phone (PWA)](#install-as-an-app-on-your-phone-pwa)
- [Interface guide](#interface-guide)
- [Favorites and playlists](#favorites-and-playlists)
- [Lyrics (.lrc)](#lyrics-lrc)
- [Audio settings: normalization, equalizer, background mode](#audio-settings-normalization-equalizer-background-mode)
- [Play your music in a Discord voice channel (optional)](#play-your-music-in-a-discord-voice-channel-optional)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Supported file formats](#supported-file-formats)
- [Project structure](#project-structure)
- [Where your data lives](#where-your-data-lives)
- [HTTP API reference](#http-api-reference)
- [How it works (internals)](#how-it-works-internals)
- [Performance notes](#performance-notes)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Highlights

**Interface**
- Spotify-style dark UI: left sidebar (playlists), main song list, bottom player bar, and a slide-in "Now Playing" panel.
- Fully responsive. On phones the sidebar becomes a slide-in drawer (hamburger), the player bar becomes a fixed mini-player, and "Now Playing" opens full-screen.
- Automatic device detection and layout adaptation; touch targets sized to avoid accidental zoom on iOS.

**Library**
- Recursive scan of the `song/` folder. Each subfolder becomes its own folder-playlist.
- **Embedded metadata** read directly from files (no database, no tags file): title, artist, album, year.
- **Embedded cover art** extracted for MP3, FLAC, and MP4/M4A; shown in the list, the player bar, the sidebar, and the Now Playing panel.
- **Automatic detection of new/removed files** — drop a file into `song/` and it appears within a few seconds, no manual refresh and no restart needed.

**Playback**
- Play / pause, next / previous, seek, per-track and full-list repeat, shuffle, volume with mute.
- "Up next" queue, with the queue tab automatically hidden while shuffle is on.
- Resumes the last track (and position) when you reopen the app.
- Media Session integration: lock-screen / headphone / OS media controls and artwork.

**Favorites and playlists (persistent, server-side)**
- Like any track; favorites load **instantly at startup** (no "Refresh" needed) and are stored on the server.
- Create real playlists from the UI, add tracks (via drag-and-drop or the track menu), remove tracks, and reorder by drag-and-drop.
- Everything is saved to a `library.json` file and survives server restarts. Duplicates are prevented.

**Lyrics**
- Reads `.lrc` (or `.txt`) sidecar files, and embedded lyrics where present.
- Time-synced highlighting and auto-scroll; tap a line to jump there.
- Robust text decoding (UTF-8 with or without BOM, UTF-16, and a Windows-1252 fallback) so accented lyrics render correctly.

**Audio quality**
- **Advanced loudness normalization**: measures each track's RMS level, applies an automatic per-track gain to even out volume, smooths transitions, and caches the result so it is computed only once per track.
- A light **compressor/limiter** tames peaks while preserving natural dynamics.
- **3-band equalizer** (bass / mid / treble) with presets (Flat, Bass, Voice, Treble, Pop).

**iPhone background playback**
- An optional mode that keeps audio playing with the screen locked or the browser backgrounded on iOS, by bypassing the in-browser audio processing graph.

**Discord broadcast (optional)**
- Connect a Discord bot from the settings panel and stream whatever you're playing into a voice channel; play / pause / skip stay in sync with the web player. Requires a one-time `npm install` (see its section below).

**Other**
- Search across title, artist, and album.
- Keyboard shortcuts.
- Settings persisted via `localStorage` (volume, shuffle, repeat, EQ, normalization, background mode, per-track gain cache).
- Auto-opens your browser on start.

---

## Requirements

- [Node.js](https://nodejs.org/) (any reasonably recent LTS release).
- A modern browser (Chrome, Edge, Firefox, or Safari). The audio graph features use the Web Audio API, which all current browsers support.

The core player needs **no dependencies** and no build step. The optional **Discord broadcast** feature is the only thing that needs `npm install` (see its dedicated section below); if you never enable it, you can ignore that entirely.

---

## Install and run

1. Download or clone this folder.
2. Put your audio/video files in the `song/` folder (subfolders are allowed — see below). The folder is created automatically on first run if it doesn't exist.
3. Start the server:

   ```bash
   node server.js
   ```

   On Windows you can simply double-click **`start.bat`**.

4. Your browser opens automatically at **`http://localhost:3000`**. If it doesn't, open that URL manually.

The console prints how many files were detected and how many favorites/playlists were loaded, for example:

```
Spotify Local running at http://localhost:3000
Bibliotheque : 128 fichier(s) detecte(s) dans /song
Favoris : 12 . Playlists : 3
```

To stop the server, press `Ctrl + C` in the terminal.

---

## Adding your music

- Drop files anywhere inside `song/`. The scan is **recursive**.
- **Top-level files** appear under **"All tracks"**.
- **Each subfolder** becomes its own folder-playlist in the sidebar. For example:

  ```
  song/
  ├── intro.mp3                 -> appears in "All tracks"
  ├── Rock/
  │   ├── song-a.flac           -> folder-playlist "Rock"
  │   └── song-b.mp3
  └── Chill/
      └── lofi.m4a              -> folder-playlist "Chill"
  ```

- New files are picked up automatically (a lightweight signature is polled in the background and the server also watches the folder), so you rarely need to touch the **Refresh** button.

### Adding lyrics

Place a `.lrc` (preferred, for synced lyrics) or `.txt` file **next to the track, with the same base name**:

```
song/Rock/song-a.mp3
song/Rock/song-a.lrc      <- lyrics for song-a
```

Embedded lyrics inside the audio file are also read when no sidecar file is found.

---

## Using it on your phone (iPhone / Android)

The player is served over your local network, so your phone can use it while the computer is running.

1. Keep the computer running the server **on the same Wi-Fi network** as the phone.
2. Find the computer's local IP address:
   - **Windows:** run `ipconfig` and read the "IPv4 Address" (looks like `192.168.x.x`).
   - **macOS/Linux:** run `ifconfig` or `ip addr`.
3. On the phone's browser, open **`http://<computer-ip>:3000`** (for example `http://192.168.0.34:3000`).

On the phone:
- Tap the **hamburger** (top-left) to open playlists.
- Tap the **gear** (top-right) to open audio settings.
- The **mini-player** is pinned at the bottom; tap it to open the full-screen Now Playing view.
- To keep music playing with the screen locked, enable **"Background playback (iPhone)"** in settings, then **reload the page** (see the caveats below).

> If your phone can't reach the page, your computer's firewall may be blocking inbound connections on port 3000. Allow Node.js through the firewall, or allow the port on a private network.

---

## Install as an app on your phone (PWA)

The player is also a **Progressive Web App (PWA)**: you can "install" it so it gets its own icon on the home screen and opens in full screen, without the browser address bar — just like a native app.

**On iPhone (Safari):**
1. Open `http://<computer-ip>:3000` in Safari while on the same Wi-Fi as the computer.
2. Tap the **Share** button (square with an arrow), then **Add to Home Screen**.
3. Name it (e.g. "Spotafy") and tap **Add**. The app now appears on your home screen with its icon and opens full screen.

**On Android (Chrome/Edge):**
1. Open the same URL, tap the menu (**⋮**), then **Install app** / **Add to Home screen**.

**What this changes**
- The interface (UI, buttons, layout) is cached by the service worker, so it opens instantly and even loads with **no connection** (you still need the computer/server reachable to actually play music).
- The music itself is streamed live from your PC, so playback still requires the phone to be connected to the same network (or to the tunnel/address that reaches your PC). A PWA cannot make the audio play fully offline — that would require a native app that stores files on the phone.

**Files added for the PWA**
- `manifest.webmanifest` — app name, icon, and full-screen (`standalone`) display settings.
- `sw.js` — service worker that caches the interface for fast/offline opening.
- `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` — app icons.
- `server.js` and `index.html` were updated to serve these files and to register the service worker / link the manifest (including the iOS `apple-mobile-web-app-capable` tags).

---

## Interface guide

**Sidebar (left).** Lists all playlists in order: All tracks, Liked songs, one entry per subfolder, then your custom playlists. The **+** button creates a new playlist. Double-click a playlist to start playing it. On mobile this is the slide-in drawer.

**Song list (center).** Hover a row (desktop) to reveal the play button and the like / menu (⋯) buttons. Click the title to play (single-tap on mobile). The header shows the playlist name and total duration.

**Player bar (bottom).** Now-playing art and title, transport controls (shuffle, previous, play/pause, next, repeat), a seek bar with times, a settings gear, a Now-Playing toggle, and volume. On mobile it collapses to a fixed mini-player with a thin progress line.

**Now Playing panel (right / full-screen on mobile).** Large cover, title/artist/album, a like button, a frequency visualizer, and two tabs: **Up next** (the queue) and **Lyrics**.

**Settings popover.** Opened via the gear. Contains normalization, equalizer, and iPhone background-playback toggles.

---

## Favorites and playlists

**Favorites (Liked songs).** Click the heart on any row, in the player bar, or in the Now Playing panel. The state updates immediately with a small animation, and is saved on the server so it is present the moment the app loads next time. "Liked songs" is always the second entry in the sidebar.

**Custom playlists.**
- **Create:** the **+** next to "Playlists" in the sidebar.
- **Add a track:**
  - **Drag-and-drop** (best on desktop): drag a row from any list onto a playlist in the sidebar — it is copied in (the original stays in its folder). Dragging onto **Liked songs** likes it.
  - **Track menu (best on phones):** open a row's **⋯** menu and choose a playlist (or create one on the spot).
- **Remove a track:** open the **⋯** menu of a row while viewing a custom playlist.
- **Reorder:** drag rows up/down within a custom playlist.
- **Rename / delete:** the **⋯** menu on the playlist itself in the sidebar.

All changes are written to `library.json` and persist across restarts.

---

## Lyrics

Open the Now Playing panel and select the **Lyrics** tab.

- **Synced lyrics** (`.lrc` with `[mm:ss.xx]` timestamps) highlight the current line and auto-scroll; tap a line to seek to it.
- **Plain lyrics** (`.txt`, or `.lrc` without timestamps) are shown as scrolling text.
- If nothing is found, a clear message explains how to add an `.lrc` file.
- Encoding is detected automatically (UTF-8 ±BOM, UTF-16 LE/BE, with a Windows-1252 fallback) so accents and special characters display correctly.

Example `.lrc`:

```
[00:00.00]First line
[00:04.50]Second line
[00:09.10]Third line
```

---

## Audio settings: normalization, equalizer, background mode

Open the **gear** in the player bar (or the "Audio settings" entry in the mobile drawer).

**Normalization (on by default).** Evens out perceived loudness between tracks. For each track, the player measures the signal's RMS over the first few seconds, computes a gain to bring it toward a target level, applies it smoothly (no abrupt jumps), and caches the value per track so it isn't recomputed next time. A gentle compressor/limiter in the chain catches loud peaks while leaving the track's natural dynamics intact.

**Equalizer (off by default).** A 3-band EQ — bass (low shelf ~150 Hz), mid (peaking ~1 kHz), treble (high shelf ~3.5 kHz), each ±12 dB — with one-tap presets: Flat, Bass, Voice, Treble, Pop.

**Background playback (iPhone).** iOS pauses Web-Audio-routed media when Safari is backgrounded. Enabling this mode plays the audio element directly (bypassing the processing graph) so playback continues with the screen locked. Trade-offs while it is on:
- Normalization, equalizer, and the visualizer are disabled (they require the audio graph).
- You must **reload the page** after toggling this setting for it to take effect.

---

## Play your music in a Discord voice channel (optional)

You can have a Discord bot join a voice channel and play whatever you're listening to in Spotafy Local. It mirrors your local playback: when you play, pause, or skip in the web player, the bot follows along. The audio comes straight from the files in your `song/` folder — nothing is uploaded anywhere except into your own voice channel.

### 1. Install the dependencies (one time)

From the project folder:

```bash
npm install
```

This installs `discord.js`, `@discordjs/voice` (with `libsodium-wrappers` for voice encryption), `ffmpeg-static` (to decode MP3/FLAC/etc.), and `@discordjs/opus` (the Opus encoder).

> **If `@discordjs/opus` fails to compile** (it needs build tools on some systems, especially Windows), replace it with the pure-JavaScript encoder instead — it's slower but needs no compiler:
> ```bash
> npm uninstall @discordjs/opus
> npm install opusscript
> ```
> `@discordjs/voice` automatically uses whichever Opus library is present, so no code change is needed.

You can verify your audio stack is complete by running:

```bash
node -e "console.log(require('@discordjs/voice').generateDependencyReport())"
```

You should see at least one Opus library, one encryption library, and FFmpeg listed as found.

### 2. Create a bot and get its token

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Open the **Bot** tab → **Reset Token** → copy the token. Keep it secret (anyone with it controls your bot).
3. Under **Privileged Gateway Intents**, the defaults are fine — this bot only needs the standard *Guilds* and *Guild Voice States* intents, which are enabled by default.

### 3. Invite the bot to your server

1. In the **OAuth2 → URL Generator**, tick the **`bot`** scope.
2. Under bot permissions, tick **Connect** and **Speak** (voice). **View Channels** is also helpful.
3. Open the generated URL in your browser and add the bot to a server you manage.

### 4. Connect it in Spotafy Local

1. Start the app (`node server.js`) and open the settings panel (the gear icon, bottom-right).
2. Turn on **Diffuser sur Discord**.
3. Paste the bot token, click **Connecter**. Once it shows *En ligne*, pick a voice channel from the dropdown.
4. Press play on any track — it now streams into that channel. Use **Couper le son de l'ordinateur** if you only want to hear it through Discord.

The token is stored only in your browser's `localStorage` (`spotify_dc_token`) and held in the server's memory while it runs — it is never written to `library.json` or any other file on disk. The bot stays connected across page reloads; it disconnects when you click **Déconnecter** or stop the server.

### Notes and limits

- Discord's terms expect a bot to behave like a bot (its own application/token), not a user account. Don't paste a personal user token — that's against Discord's rules and won't work here anyway.
- Playback sync covers play / pause / track changes. Fine-grained seeking inside a track isn't mirrored to the bot.
- Only files inside your `song/` folder can be streamed (the server rejects anything else).
- If the settings panel says *Dépendances manquantes*, you haven't run `npm install` yet.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Arrow Left` | Seek backward 5s |
| `Arrow Right` | Seek forward 5s |
| `Ctrl + Arrow Left` | Previous track |
| `Ctrl + Arrow Right` | Next track |
| `Arrow Up` | Volume up |
| `Arrow Down` | Volume down |
| `L` | Like / unlike the current track |
| `Q` | Toggle the Now Playing panel |
| `S` | Toggle shuffle |
| `R` | Cycle repeat (off → all → one) |
| `/` | Focus the search box |
| `Escape` | Clear search / close menus |

---

## Supported file formats

**Audio:** MP3, WAV, OGG, FLAC, AAC, M4A, WMA, OPUS.
**Video:** MP4, MOV, M4V, WEBM, MKV (played as audio; the video frame is hidden).

Metadata and cover-art extraction by format:

| Format | Title / Artist / Album | Embedded cover art | Embedded lyrics |
|---|---|---|---|
| MP3 (ID3v2.2/2.3/2.4) | Yes | Yes | Yes (USLT) |
| FLAC (Vorbis comments) | Yes | Yes (PICTURE block) | Yes |
| MP4 / M4A (iTunes atoms) | Yes | Yes | Yes (`©lyr`) |
| OGG / Opus | Best-effort (text) | No (see limitations) | Best-effort |
| WAV / WMA | Filename-based | No | Sidecar only |

When metadata is missing, the file name is used as the title and "Artiste inconnu" (Unknown artist) is shown.

---

## Project structure

```
.
├── index.html      # Entire frontend: HTML + CSS + JS in one file
├── server.js       # Node.js HTTP server (pure standard library)
├── manifest.webmanifest # PWA manifest (name, icon, full-screen display)
├── sw.js           # Service worker: caches the UI for fast/offline opening
├── icon-192.png    # PWA icon (192×192)
├── icon-512.png    # PWA icon (512×512, also used as maskable)
├── apple-touch-icon.png # Icon used when added to the iOS home screen
├── discord-bot.js  # Optional Discord voice bot (deps loaded lazily)
├── package.json    # Dependencies for the optional Discord feature only
├── start.bat       # Windows quick-start (runs: node server.js)
├── README.md       # This file
├── song/           # Your media files (created on first run)
└── library.json    # Saved favorites + custom playlists (created on first save)
```

---

## Where your data lives

- **`library.json`** (next to `server.js`): your favorites and custom playlists. Shape:

  ```json
  {
    "likes": ["intro.mp3", "Rock/song-a.flac"],
    "playlists": [
      { "id": "pl_abc123", "name": "Summer", "paths": ["Rock/song-a.flac"] }
    ]
  }
  ```

  Paths are relative to the `song/` folder. You can back this file up or edit it by hand (keep valid JSON).

- **Browser `localStorage`** (per browser/device): UI and audio preferences, plus playback resume info. Keys include `spotify_volume`, `spotify_shuffle`, `spotify_repeat`, `spotify_playlist`, `spotify_norm`, `spotify_eq`, `spotify_eq_on`, `spotify_bg`, `spotify_gain` (per-track normalization cache), and `spotify_last` (resume).

---

## HTTP API reference

All responses are JSON unless noted. Paths in request bodies are relative to `song/`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | The player page (served with no-cache headers). |
| `GET` | `/api/songs` | Full library: array of `{ name, title, artist, album, year, path, folder, hasCover }`. |
| `GET` | `/api/library` | Saved data: `{ likes: [...], playlists: [...] }`. |
| `GET` | `/api/version` | Lightweight library signature `{ sig }` used by the client to detect added/removed files. |
| `GET` | `/cover/<path>` | Embedded cover image bytes for a track (cached 1 day). |
| `GET` | `/lyrics/<path>` | `{ synced: boolean, text: string }` from sidecar or embedded lyrics. |
| `GET` | `/song/<path>` | The media stream, with HTTP `Range` support for seeking. |
| `POST` | `/api/like` | Body `{ path, liked }`. Adds/removes a favorite (de-duplicated). |
| `POST` | `/api/playlists` | Body `{ action, ... }`. See below. |
| `GET` | `/api/discord/status` | Bot state: `{ status, user, guildName, channelName, playing, nowPlaying, hasDeps, ... }`. |
| `GET` | `/api/discord/channels` | Voice channels visible to the bot: `{ guilds: [{ id, name, channels: [...] }] }`. |
| `POST` | `/api/discord/start` | Body `{ token }`. Logs the bot in. |
| `POST` | `/api/discord/stop` | Disconnects the bot. |
| `POST` | `/api/discord/join` | Body `{ guildId, channelId }`. Joins a voice channel. |
| `POST` | `/api/discord/play` | Body `{ path, name }`. Streams a track from `song/` to the channel. |
| `POST` | `/api/discord/pause` / `/resume` / `/skip` | Playback control for the bot. |

`POST /api/playlists` actions:

| `action` | Required fields | Effect |
|---|---|---|
| `create` | `name` | Create a new playlist. |
| `rename` | `id`, `name` | Rename a playlist. |
| `delete` | `id` | Delete a playlist. |
| `add` | `id`, `path` | Add a track (ignored if already present). |
| `remove` | `id`, `path` | Remove a track. |
| `setpaths` | `id`, `paths[]` | Replace the ordered track list (used for reordering). |

Every mutation returns the updated collection and is written to `library.json`.

---

## How it works (internals)

- **Pure Node standard library.** `server.js` uses only `http`, `fs`, and `path`. There is no framework and no dependency to install.
- **Metadata and cover parsing** are implemented as small, hand-written binary parsers for ID3v2 (MP3), Vorbis comments + PICTURE (FLAC/OGG), and iTunes atoms (MP4/M4A). Parsed metadata is cached in memory keyed by file path + size + modification time.
- **Streaming** honors the `Range` header so the browser can seek without downloading whole files.
- **Live updates.** The server watches `song/` and exposes a cheap `/api/version` signature; the client polls it every ~10 seconds and reloads the library when it changes — without interrupting the track that is playing.
- **The frontend** is a single `index.html` containing all markup, styles, and logic. Audio routing (EQ → normalization gain → compressor → analyser) uses the Web Audio API, with a separate analyser tap for loudness measurement.

---

## Performance notes

- Track durations are probed using **metadata-only** loads, at most a couple at a time on mobile, with rendering debounced. This avoids saturating Wi-Fi (an earlier version downloaded whole files just to read durations, which caused stutter on phones).
- Cover images are lazy-loaded in lists and cached by the browser for a day.
- Parsed metadata is cached server-side, so repeated scans are fast.

---

## Troubleshooting

**My latest change to `index.html` doesn't show up.**
The server now sends no-cache headers for the page, so this should not happen anymore. If you are still seeing an old version once, force a hard reload: desktop `Ctrl/Cmd + Shift + R`; iOS Safari, close the tab and reopen, or long-press reload; Android Chrome, menu → reload. After that, updates appear on a normal reload.

**The phone can't open the page.**
Confirm both devices are on the same Wi-Fi, that you used the computer's `192.168.x.x` address (not `localhost`), and that the OS firewall allows Node.js / port 3000 on private networks.

**Playback stops or stutters on iPhone.**
Enable "Background playback (iPhone)" in settings and reload the page. This bypasses the audio graph that iOS can interrupt.

**No cover art for some files.**
OGG/Opus embedded covers are not extracted (text metadata only). For other formats, the file may simply have no embedded image.

**"Port 3000 already in use".**
Another process (or a second copy of this app) is using it. Close it, or change `PORT` near the top of `server.js`.

**Lyrics show as garbled characters.**
Save the `.lrc` as UTF-8 if possible. The server also handles UTF-16 and falls back to Windows-1252, but UTF-8 is the most reliable.

---

## Privacy

Everything runs locally. Your files never leave your machine, there is no telemetry, no analytics, and no external network calls. The only network traffic is between your browser/phone and your own computer on your LAN.

---

## Known limitations

- OGG/Opus embedded cover art is not extracted (other metadata is).
- Drag-and-drop reordering and track-to-playlist dragging are designed for desktop; on phones use the **⋯** track menu instead.
- Background mode on iPhone disables normalization, EQ, and the visualizer by design.
- The library lives in memory plus `library.json`; very large libraries (tens of thousands of files) will scan more slowly.

---

## License

Provided as-is for personal, local use. Spotify is a trademark of its owner; this project is an independent, Spotify-*inspired* interface and is not affiliated with or endorsed by Spotify.
