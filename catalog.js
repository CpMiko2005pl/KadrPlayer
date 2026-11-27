const { WebContentsView, session, powerSaveBlocker } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');

const origin = 'https://hydrahd.com';
// The .com catalog redirects movie pages to a playback domain listed on hydrahd.info.
const movieOrigins = new Set([origin, 'https://hydrahd.gd', 'https://hydrahd.ac', 'https://hydrahd.cc',
  'https://hydrahd.io', 'https://hydrahd.me', 'https://hydrahd.ws']);
let player = null;
let catalogSession = null;

function getSession() {
  if (catalogSession) return catalogSession;
  catalogSession = session.fromPartition('kadr-hydra');
  catalogSession.setPermissionCheckHandler(() => false);
  catalogSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
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

// Keep the provider's MediaSource, cookies and decoding in its sandbox. Only the
// playing video and the chain of frames that contains it occupy the local stage.
function showOnly(element) {
  if (!element) return false;
  const set = (el, styles) => {
    for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, 'important');
  };
  let child = element;
  while (child) {
    if (child.parentElement) for (const sibling of child.parentElement.children) {
      if (sibling !== child && !['HEAD', 'SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) {
        set(sibling, { visibility: 'hidden', 'pointer-events': 'none', opacity: '0' });
      }
    }
    set(child, { position: 'fixed', inset: '0', display: 'block', margin: '0', padding: '0', border: '0',
      width: '100%', height: '100%', 'max-width': 'none', 'max-height': 'none', transform: 'none', overflow: 'hidden',
      opacity: '1', visibility: 'visible', 'background-color': 'black', 'z-index': '2147483647', 'object-fit': 'contain' });
    child = child.parentElement;
  }
  return true;
}

function closeMovie() {
  const p = player;
  if (!p) return;
  player = null;
  p.abort.abort();
  if (p.blocker !== undefined) powerSaveBlocker.stop(p.blocker);
  if (p.attached && !p.parent.isDestroyed()) p.parent.contentView.removeChildView(p.view);
  if (!p.contents.isDestroyed()) p.contents.close({ waitForBeforeUnload: false });
}

function positionMovie(p, bounds) {
  if (!bounds || !['x','y','width','height'].every(k => Number.isFinite(bounds[k]))) return;
  const [w, h] = p.parent.getContentSize();
  const x = Math.max(0, Math.min(w - 1, Math.round(bounds.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(bounds.y)));
  p.view.setBounds({ x, y, width: Math.max(1, Math.min(w - x, Math.round(bounds.width))),
    height: Math.max(1, Math.min(h - y, Math.round(bounds.height))) });
}

async function prepareVideo(p) {
  const contents = p.contents;
  while (!p.abort.signal.aborted) {
    const frames = contents.mainFrame.framesInSubtree;
    for (const frame of frames) {
      if (p.abort.signal.aborted) return;
      const ready = await frame.executeJavaScript(`(() => {
        for (const v of document.querySelectorAll('video')) {
          if (v.paused && !v.ended && !v.error) void v.play().catch(() => {});
          if (v.videoWidth && v.readyState >= 2 && v.duration > 0 && !v.error) {
            v.setAttribute('data-kadr-film', '');
            return true;
          }
        }
        return false;
      })()`, true).catch(() => false);
      if (!ready) continue;
      await frame.executeJavaScript(`(${showOnly})(document.querySelector('video[data-kadr-film]'))`);
      for (let child = frame; child.parent; child = child.parent) {
        // WindowProxy identity works even when parent and child have different origins.
        const i = await child.executeJavaScript('Array.from({length:parent.length}, (_,i)=>parent[i]).indexOf(window)');
        if (i < 0 || !await child.parent.executeJavaScript(`(${showOnly})(Array.from(document.querySelectorAll('iframe,frame')).find(el => el.contentWindow === frames[${i}]))`)) {
          throw new Error('Nie można wyświetlić obrazu filmu.');
        }
      }
      p.frame = frame;
      return;
    }
    await delay(450, undefined, { signal: p.abort.signal });
  }
}

async function startProvider(p, address) {
  const contents = p.contents;
  await new Promise((resolve, reject) => {
    p.abort.signal.addEventListener('abort', () => reject(new Error('Przerwano wczytywanie filmu.')), { once: true });
    contents.once('dom-ready', () => resolve());
    contents.loadURL(address).catch(reject);
  });
  const started = await contents.mainFrame.executeJavaScript(`(() => {
    const play = document.querySelector('.video-play-button');
    if (play) play.click();
    return !!play || !!document.querySelector('video');
  })()`, true);
  if (!started) throw new Error('Serwis nie udostępnił odtwarzacza.');
}

async function openMovie(parent, address, id, bounds, volume) {
  const url = movieAddress(address);
  if (!url || !Number.isSafeInteger(id)) throw new Error('Nieprawidłowy film.');
  closeMovie();
  const view = new WebContentsView({
    webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  const contents = view.webContents;
  const p = player = { id, parent, view, contents, abort: new AbortController(), attached: false, frame: null };
  view.setBackgroundColor('#000000');
  positionMovie(p, bounds);
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const restrictNavigation = event => {
    if (event.isMainFrame && (p.attached || !movieAddress(event.url))) event.preventDefault();
  };
  contents.on('will-frame-navigate', restrictNavigation);
  contents.on('will-redirect', restrictNavigation);
  contents.on('before-input-event', (event, key) => {
    if (key.type === 'keyDown' && [' ', 'Escape', 'ArrowLeft','ArrowRight','m','f'].includes(key.key)) {
      event.preventDefault(); parent.webContents.send('catalog:key', key.key);
    }
  });
  const timeout = setTimeout(() => { if (player === p) closeMovie(); }, 50000);
  try {
    await startProvider(p, url);
    await prepareVideo(p);
    if (player !== p || !p.frame) return false;
    await movieAction(id, 'volume', volume);
    if (player !== p) return false;
    parent.contentView.addChildView(view);
    p.attached = true;
    parent.webContents.focus();
    contents.setAudioMuted(false);
    return true;
  } catch (err) {
    if (player === p) closeMovie();
    throw err;
  } finally { clearTimeout(timeout); }
}

async function movieAction(id, action, value) {
  const p = player;
  if (!p || p.id !== id) return null;
  if (action === 'close') { closeMovie(); return null; }
  if (action === 'bounds') { positionMovie(p, value); return null; }
  if (action === 'visible') { p.view.setVisible(value === true); return null; }
  if (!p.frame) return null;
  let change = '';
  if (action === 'toggle') change = "if(v.paused) void v.play().catch(()=>{}); else v.pause();";
  else if (action === 'seek' && Number.isFinite(value)) change = `if(Number.isFinite(v.duration)) v.currentTime=Math.max(0,Math.min(v.duration,${value}));`;
  else if (action === 'volume' && Number.isFinite(value)) change = `v.volume=${Math.max(0,Math.min(1,value))}; v.muted=v.volume===0;`;
  else if (action !== 'status') return null;
  const state = await p.frame.executeJavaScript(`(() => { const v=document.querySelector('video[data-kadr-film]'); if(!v||v.error) return null;
    ${change} return { time:v.currentTime, duration:Number.isFinite(v.duration)?v.duration:0, paused:v.paused, ended:v.ended, volume:v.muted?0:v.volume }; })()`, action === 'toggle');
  if (player === p && state) {
    if (!state.paused && p.blocker === undefined) p.blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (state.paused && p.blocker !== undefined) { powerSaveBlocker.stop(p.blocker); p.blocker = undefined; }
  }
  return state;
}

module.exports = { fetchCatalog, openMovie, movieAction, closeMovie };
