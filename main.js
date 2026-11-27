// Kadr Player — main process: window, settings, dialogs, menus, file associations, the media server
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen, powerSaveBlocker, nativeTheme, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { Media } = require('./media');
const catalog = require('./catalog');

const DEBUG = process.env.KADR_DEBUG === '1';
const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'f4v', 'mpg', 'mpeg', 'm2v', 'ts', 'm2ts', 'mts', 'vob', '3gp', '3g2', 'ogv', 'divx', 'xvid', 'rm', 'rmvb', 'asf', 'dv', 'mxf', 'y4m', 'hevc', '264', '265', 'h264', 'h265', 'ivf', 'nut', 'amv', 'qt', 'mjpeg', 'gif'];
const AUDIO_EXT = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'ac3', 'eac3', 'dts', 'ape', 'wv', 'mka', 'aiff', 'aif', 'alac', 'tta', 'mpc', 'amr', 'mid', 'caf', 'weba'];
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT]);
const LIST_EXT = new Set(['m3u', 'm3u8', 'pls']);

app.setAppUserModelId('fun.tacticalops.kadrplayer');
nativeTheme.themeSource = 'dark';

const userDir = app.getPath('userData');
const logFile = path.join(userDir, 'kadr.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  if (DEBUG) process.stdout.write(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch {}
}

// ---------- persistent JSON files ----------
function store(name, defaults) {
  const file = path.join(userDir, name);
  let data = defaults;
  try { data = Object.assign({}, defaults, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  let timer = null;
  return {
    get: () => data,
    set(v) { data = v; clearTimeout(timer); timer = setTimeout(() => this.flush(), 400); },
    flush() { clearTimeout(timer); try { fs.mkdirSync(userDir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); } catch (e) { log('save failed', name, e.message); } },
  };
}
const settings = store('settings.json', {});
const state = store('state.json', { recent: [], resume: {}, bounds: null, maximized: false });

// Chromium switches have to be set before the app is ready
const S0 = settings.get();
if (S0.hwdec === false) app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
if (S0.gpuVsync === false) app.commandLine.appendSwitch('disable-gpu-vsync');

let win = null;
let media = null;
let pendingOpen = [];
let blocker = null;

function filesFromArgv(argv) {
  const skip = new Set([process.execPath.toLowerCase(), app.getAppPath().toLowerCase()]);
  const out = [];
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    if (/^https?:\/\//i.test(a)) { out.push(a); continue; }
    const p = path.resolve(a);
    if (skip.has(p.toLowerCase()) || p.toLowerCase() === path.resolve('.').toLowerCase() && a === '.') continue;
    try { if (fs.existsSync(p) && p !== app.getAppPath()) out.push(p); } catch {}
  }
  return out;
}

if (!DEBUG && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const files = filesFromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      if (files.length) win.webContents.send('open-files', { files, replace: true });
    }
  });
  app.whenReady().then(start);
}

async function start() {
  media = new Media({ appDir: __dirname, resourcesDir: process.resourcesPath, packaged: app.isPackaged, log });
  await media.start();
  log('media server', media.base, 'ffmpeg', media.ffmpeg);
  pendingOpen = filesFromArgv(process.argv);
  createWindow();
}

function createWindow() {
  const st = state.get();
  let b = st.bounds;
  if (b) {
    const area = screen.getDisplayMatching(b).workArea;
    if (b.x + 80 > area.x + area.width || b.y + 40 > area.y + area.height || b.x + b.width < area.x + 80 || b.y < area.y - 10) b = null;
  }
  win = new BrowserWindow({
    width: b ? b.width : 1180, height: b ? b.height : 700, x: b ? b.x : undefined, y: b ? b.y : undefined,
    minWidth: 360, minHeight: 220,
    backgroundColor: '#07080b',
    title: 'Kadr Player',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#d7dbe4', height: 38 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); openExternal(url); } });
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized() || win.__mini) return;
    const s = state.get();
    s.maximized = win.isMaximized();
    if (!s.maximized) s.bounds = win.getBounds();
    state.set(s);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  win.on('maximize', () => win.webContents.send('maximized', true));
  win.on('unmaximize', () => win.webContents.send('maximized', false));
  win.on('close', () => catalog.closeMovie());
  win.on('closed', () => { win = null; });
  if (DEBUG) win.webContents.on('console-message', (e, level, msg, line, src) => log('page', level, msg, src ? `${path.basename(src)}:${line}` : ''));
  win.webContents.on('render-process-gone', (e, d) => log('renderer gone', d));
}

function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return;
  if (process.env.KADR_NO_EXTERNAL === '1') return log('external link (not opened):', url);
  shell.openExternal(url);
}

// a crash of the GPU process while a video plays usually means the hardware decoder can't handle that codec
app.on('child-process-gone', (e, d) => {
  log('child process gone', d);
  if (d.type === 'GPU' && win && !win.isDestroyed()) win.webContents.send('gpu-crash', d.reason);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  settings.flush(); state.flush();
  if (media) media.stop();
});

// ---------- IPC ----------
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) throw new Error('Niedozwolone źródło wywołania.');
  try { return await fn(...a); } catch (err) { log('ipc error', ch, err && err.stack || err); throw err; }
});

handle('app:init', async () => ({
  base: media.base, token: media.token, version: app.getVersion(),
  settings: settings.get(), state: state.get(),
  open: pendingOpen.splice(0),
  debug: DEBUG, ffmpeg: media.ffmpeg,
  pictures: app.getPath('pictures'),
}));
handle('app:ffmpeg-version', () => media.version());
// the page already debounces, so write right away (a change made just before closing must not be lost)
handle('settings:set', s => { settings.set(s); settings.flush(); return true; });
// the page owns only "recent" and "resume"; window bounds stay with the main process
handle('state:set', s => { state.set(Object.assign({}, state.get(), { recent: s.recent, resume: s.resume })); state.flush(); return true; });
handle('media:probe', input => media.probe(input));
handle('media:find-in-page', url => media.findInPage(url));
handle('catalog:list', request => catalog.fetchCatalog(request));
handle('catalog:series', url => catalog.fetchSeries(url));
handle('catalog:play', (url, id, bounds, volume) => catalog.openMovie(win, url, id, bounds, volume));
const captions = require('./captions');
let captionJob;
function stopCaptionJob() {
  if (!captionJob) return;
  captionJob.abort.abort();
  if (captionJob.id != null) void catalog.movieAction(captionJob.id, 'capture-cancel').catch(() => {});
}
app.on('before-quit', stopCaptionJob);
handle('captions:cancel', stopCaptionJob);
handle('captions:generate', async ({ id, file, stream, start, length, key }) => {
  if (captionJob) throw Error('Generowanie jest już uruchomione.');
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{12,250}$/.test(key)) throw Error('Wprowadź prawidłowy klucz API Groq.');
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(length) || length <= 0 || length > 7 * 86400) throw Error('Nieprawidłowy zakres nagrania.');
  if (id == null && (!path.isAbsolute(file) || !fs.statSync(file).isFile())) throw Error('Wybierz lokalny plik multimedialny.');
  const job = captionJob = { id, abort: new AbortController() };
  const signal = job.abort.signal;
  const cues = [];
  let previous;
  try {
    if (id != null) {
      previous = await catalog.movieAction(id, 'status');
      if (!previous) throw Error('Odtwarzacz filmu jest niedostępny.');
    }
    for (let position = start; position < start + length - 0.15;) {
      signal.throwIfAborted();
      const seconds = Math.min(id == null ? 300 : 60, start + length - position);
      win.webContents.send('captions:progress', { position, seconds, start, length });
      let audio, offset = position, end = position + seconds;
      if (id == null) audio = await captions.localAudio(media.ffmpeg, file, position, seconds, stream, signal);
      else {
        const clip = await catalog.movieAction(id, 'capture', { start: position, seconds });
        if (!clip || typeof clip.audio !== 'string' || clip.audio.length > 12000000 || !Number.isFinite(clip.offset) || !Number.isFinite(clip.end) || clip.end <= position + 0.01) throw Error('Nie udało się pobrać dźwięku odtwarzacza.');
        audio = Buffer.from(clip.audio, 'base64');
        offset = clip.offset;
        end = clip.end;
      }
      signal.throwIfAborted();
      const segments = await captions.transcribe(audio, id == null ? 'audio.mp3' : 'audio.webm', key, signal);
      for (const s of segments) {
        const from = Math.max(offset, offset + s.start), to = Math.min(end, offset + s.end);
        if (to > from) cues.push({ start: from, end: to, text: s.text });
      }
      position = end;
    }
    return { cues };
  } catch (error) {
    if (cues.length && !signal.aborted) return { cues, warning: 'Zachowano gotową część napisów. ' + error.message };
    throw error;
  } finally {
    if (previous) {
      const state = await catalog.movieAction(id, 'seek', previous.time).catch(() => null);
      if (state && state.paused !== previous.paused) await catalog.movieAction(id, 'toggle').catch(() => {});
    }
    captionJob = null;
  }
});
handle('captions:save', async (title, text) => {
  const { filePath } = await dialog.showSaveDialog(win, { defaultPath: String(title).replace(/[<>:"/\\\\|?*]/g, '_') + '.srt', filters: [{ name: 'Napisy SRT', extensions: ['srt'] }] });
  if (filePath) await fs.promises.writeFile(filePath, text, 'utf8');
});
handle('catalog:movie-details', address => catalog.fetchMovieDetails(address));
handle('catalog:action', (id, action, value) => catalog.movieAction(id, action, value));
handle('media:encoders', () => media.encoders());
handle('media:cropdetect', (input, dur) => media.cropdetect(input, dur));
handle('media:sub-embedded', (input, index) => media.embeddedSubtitle(input, index));
handle('media:read-text', file => media.readText(file));
handle('media:find-subs', file => media.findSubtitles(file));
handle('gpu:info', async () => {
  try {
    const g = await app.getGPUInfo('basic');
    return { devices: (g.gpuDevice || []).map(d => ({ vendor: d.vendorId, device: d.deviceId, active: d.active })), aux: g.auxAttributes || {} };
  } catch { return null; }
});
handle('gpu:feature-status', () => app.getGPUFeatureStatus());

handle('dialog:open-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Otwórz pliki', properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Wideo i dźwięk', extensions: [...MEDIA_EXT, ...LIST_EXT] },
      { name: 'Wideo', extensions: VIDEO_EXT }, { name: 'Dźwięk', extensions: AUDIO_EXT },
      { name: 'Listy odtwarzania', extensions: [...LIST_EXT] }, { name: 'Wszystkie pliki', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:open-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Otwórz folder z filmami', properties: ['openDirectory'] });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:open-subtitle', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Wczytaj napisy', properties: ['openFile'], filters: [{ name: 'Napisy', extensions: ['srt', 'ass', 'ssa', 'vtt', 'sub', 'txt', 'mpl'] }, { name: 'Wszystkie pliki', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:save-playlist', async (text) => {
  const r = await dialog.showSaveDialog(win, { title: 'Zapisz listę odtwarzania', defaultPath: 'lista.m3u8', filters: [{ name: 'Lista M3U', extensions: ['m3u8', 'm3u'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, '﻿' + text, 'utf8');
  return r.filePath;
});

// expand folders and playlists into media files
handle('files:expand', async (inputs) => {
  const out = [];
  const natural = (a, b) => a.localeCompare(b, 'pl', { numeric: true, sensitivity: 'base' });
  const walk = (dir, depth) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = list.filter(d => d.isFile() && MEDIA_EXT.has(path.extname(d.name).slice(1).toLowerCase())).map(d => d.name).sort(natural);
    for (const f of files) out.push(path.join(dir, f));
    if (depth > 0) for (const d of list.filter(d => d.isDirectory()).map(d => d.name).sort(natural)) walk(path.join(dir, d), depth - 1);
  };
  for (const p of inputs) {
    if (/^https?:\/\//i.test(p)) { out.push(p); continue; }
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, 3);
    else if (LIST_EXT.has(path.extname(p).slice(1).toLowerCase())) out.push(...readPlaylist(p));
    else out.push(p);
  }
  return out;
});

function readPlaylist(file) {
  const { decodeText } = require('./media');
  const text = decodeText(fs.readFileSync(file));
  const dir = path.dirname(file);
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (/^file\d+=/i.test(line)) line = line.replace(/^file\d+=/i, '');
    else if (!line || line.startsWith('#') || line.startsWith('[') || line.includes('=')) continue;
    if (/^https?:\/\//i.test(line)) out.push(line);
    else if (/^file:\/\//i.test(line)) { try { out.push(require('url').fileURLToPath(line)); } catch {} }
    else out.push(path.resolve(dir, line));
  }
  return out;
}

handle('file:stat', p => { try { const s = fs.statSync(p); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; } });
handle('file:show', p => { shell.showItemInFolder(p); return true; });
handle('open:external', url => { openExternal(url); return true; });
handle('clipboard:text', () => clipboard.readText());

handle('screenshot:save', async ({ dataUrl, name }) => {
  const dir = path.join(app.getPath('pictures'), 'Kadr Player');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'kadr').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').slice(0, 120);
  let file = path.join(dir, `${safe}.png`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${safe} (${i}).png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
});

// window
handle('win:fullscreen', v => { if (win) win.setFullScreen(v === undefined ? !win.isFullScreen() : !!v); return win && win.isFullScreen(); });
handle('win:on-top', v => { if (win) win.setAlwaysOnTop(!!v, 'floating'); return !!v; });
handle('win:minimize', () => win && win.minimize());
handle('win:title', t => { if (win) win.setTitle(t); });
handle('win:progress', v => { if (win) win.setProgressBar(v < 0 ? -1 : v); });
handle('win:overlay', o => { try { win && win.setTitleBarOverlay(o); } catch {} });
handle('win:mini', on => {
  if (!win) return false;
  if (on && !win.__mini) {
    win.__restore = { bounds: win.getBounds(), maximized: win.isMaximized(), top: win.isAlwaysOnTop() };
    win.__mini = true;
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const w = 420, h = 236;
    win.setMinimumSize(240, 135);
    win.setBounds({ x: area.x + area.width - w - 16, y: area.y + area.height - h - 16, width: w, height: h });
    win.setAlwaysOnTop(true, 'floating');
  } else if (!on && win.__mini) {
    win.__mini = false;
    const r = win.__restore || {};
    win.setMinimumSize(360, 220);
    if (r.bounds) win.setBounds(r.bounds);
    if (r.maximized) win.maximize();
    win.setAlwaysOnTop(!!r.top, 'floating');
  }
  return !!win.__mini;
});
handle('win:fit-video', ({ w, h, scale }) => {
  if (!win || win.isFullScreen() || win.isMaximized() || win.__mini || !w || !h) return;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  let cw = Math.round(w * (scale || 1)), ch = Math.round(h * (scale || 1));
  const maxW = area.width * 0.9, maxH = area.height * 0.9;
  const k = Math.min(1, maxW / cw, maxH / ch);
  cw = Math.max(480, Math.round(cw * k)); ch = Math.max(270, Math.round(ch * k));
  const b = win.getBounds();
  const x = Math.round(Math.min(Math.max(area.x, b.x + (b.width - cw) / 2), area.x + area.width - cw));
  const y = Math.round(Math.min(Math.max(area.y, b.y + (b.height - ch) / 2), area.y + area.height - ch));
  win.setContentBounds({ x, y, width: cw, height: ch });
});

handle('power:block', on => {
  if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  return on;
});

// native popup menu described by the page: [{id,label,type,checked,enabled,accelerator,submenu}]
handle('menu:popup', (items) => new Promise(resolve => {
  let picked = null;
  const build = list => list.map(it => {
    if (it.type === 'separator') return { type: 'separator' };
    const o = { label: it.label, enabled: it.enabled !== false };
    if (it.type === 'checkbox' || it.type === 'radio') { o.type = it.type; o.checked = !!it.checked; }
    if (it.accelerator) { o.accelerator = it.accelerator; o.registerAccelerator = false; }
    if (it.submenu) o.submenu = build(it.submenu);
    else o.click = () => { picked = it.id; };
    return o;
  });
  const m = Menu.buildFromTemplate(build(items));
  m.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
}));

// test hooks (KADR_DEBUG=1 only)
if (DEBUG) {
  handle('test:shot', async (file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return file;
  });
  handle('test:log', (...a) => { log('TEST', ...a); return true; });
  handle('test:quit', () => { setTimeout(() => app.quit(), 50); return true; });
  handle('test:script', () => {
    const f = process.env.KADR_TEST_SCRIPT;
    return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  });
}
