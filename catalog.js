const { BrowserWindow, session } = require('electron');
const path = require('path');

const origin = 'https://hydrahd.com';
// The .com catalog redirects movie pages to a playback domain listed on hydrahd.info.
const movieOrigins = new Set([origin, 'https://hydrahd.gd', 'https://hydrahd.ac', 'https://hydrahd.cc',
  'https://hydrahd.io', 'https://hydrahd.me', 'https://hydrahd.ws']);
let player = null;
let catalogSession = null;

function getSession() {
  if (catalogSession) return catalogSession;
  catalogSession = session.fromPartition('kadr-hydra');
  catalogSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
  catalogSession.setPermissionRequestHandler((_contents, permission, respond) => respond(permission === 'fullscreen'));
  catalogSession.on('will-download', event => event.preventDefault());
  return catalogSession;
}

function movieAddress(address) {
  try {
    const url = new URL(address);
    if (movieOrigins.has(url.origin) && !url.username && !url.password && /^\/movie\/[\w-]+\/?$/.test(url.pathname)) {
      return url.origin + url.pathname;
    }
  } catch {}
  return null;
}

async function fetchCatalog({ section, query, page }) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error('Nieprawidłowa strona katalogu.');
  let url;
  if (section === 'search' && typeof query === 'string' && query.trim() && query.length <= 160) {
    const encoded = encodeURIComponent(query.trim()).replace(/%20/g, '+');
    url = new URL(page === 1 ? '/index.php' : '/search/' + encoded + '/' + page, origin);
    if (page === 1) url.search = new URLSearchParams({ menu: 'search', query: query.trim() }).toString();
  } else if (section === 'popular' || section === 'date') {
    url = new URL('/movies/' + section + '/' + (page === 1 ? '' : page), origin);
  } else throw new Error('Nieprawidłowe zapytanie do katalogu.');

  const response = await getSession().fetch(url.href, { signal: AbortSignal.timeout(18000), redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('HydraHD nie udostępnił katalogu (HTTP ' + response.status + ').');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Zbyt duża odpowiedź katalogu.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function openMovie(parent, address, title) {
  const url = movieAddress(address);
  if (!url) throw new Error('Nieprawidłowy adres filmu.');
  if (player && !player.isDestroyed()) { player.focus(); return; }
  const [width, height] = parent.getSize();
  const child = new BrowserWindow({
    parent, modal: true, width, height, minWidth: 360, minHeight: 240,
    title: String(title).slice(0, 180) + ' · Kadr Player', backgroundColor: '#07080b',
    autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
  });
  player = child;
  child.removeMenu();
  child.on('page-title-updated', event => event.preventDefault());
  const contents = child.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const restrictNavigation = event => {
    if (event.isMainFrame && !movieAddress(event.url)) event.preventDefault();
  };
  contents.on('will-frame-navigate', restrictNavigation);
  contents.on('will-redirect', restrictNavigation);
  contents.on('before-input-event', (event, key) => {
    if (key.type === 'keyDown' && key.key === 'Escape' && !child.isFullScreen()) {
      event.preventDefault();
      child.close();
    }
  });
  child.on('closed', () => { if (player === child) player = null; });
  // Subframes and streaming providers can keep the load event pending. Show the page as soon as its DOM is ready.
  contents.once('dom-ready', () => {
    contents.executeJavaScript("document.querySelector('.video-play-button')?.scrollIntoView({block:'center'})").catch(() => {});
  });
  return new Promise((resolve, reject) => {
    contents.once('dom-ready', () => resolve());
    child.once('closed', () => resolve());
    contents.loadURL(url).catch(err => {
      if (child.isDestroyed()) return;
      reject(err);
      child.destroy();
    });
  });
}

module.exports = { fetchCatalog, openMovie };
