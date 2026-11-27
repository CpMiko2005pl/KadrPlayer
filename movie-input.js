// Sandboxed preload for the movie's top frame. No API is exposed to the page.
const { ipcRenderer } = require('electron');

if (process.isMainFrame) {
  let surface, movieId, lastMove = -Infinity, previousX, previousY;
  const send = (action, value) => ipcRenderer.send('catalog:input', movieId, action, value);
  ipcRenderer.on('catalog:surface', (_event, { id, enabled, controls }) => {
    movieId = id;
    if (!surface) {
      surface = document.createElement('div');
      surface.tabIndex = -1;
      surface.setAttribute('aria-label', 'Obraz filmu');
      surface.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;background:transparent!important;outline:0!important;touch-action:none!important;';
      document.documentElement.append(surface);
      surface.addEventListener('pointermove', e => {
        if (!e.isTrusted || (e.screenX === previousX && e.screenY === previousY)) return;
        previousX = e.screenX; previousY = e.screenY;
        const now = performance.now();
        if (now - lastMove >= 100) { lastMove = now; send('pointer'); }
      });
      surface.addEventListener('pointerdown', () => surface.focus({ preventScroll: true }));
      for (const name of ['click', 'dblclick', 'contextmenu']) surface.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation();
        if (e.isTrusted) send(name);
      });
      // The shield stays above cross-origin frames, which otherwise receive native
      // Windows input directly. Leave the provider's own open menu in control.
      window.addEventListener('keydown', e => {
        if (surface.hidden || !e.isTrusted || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (![' ', 'k', 'm', 'f', 'v', 'p', 'Escape', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat || key.startsWith('Arrow')) send('key', { key, shiftKey: e.shiftKey });
      }, true);
    }
    const wasHidden = surface.hidden;
    surface.hidden = !enabled;
    surface.style.setProperty('display', enabled ? 'block' : 'none', 'important');
    surface.style.setProperty('cursor', controls ? 'default' : 'none', 'important');
    if (!controls) lastMove = -Infinity;
    if (enabled && (wasHidden || document.activeElement?.tagName === 'IFRAME')) surface.focus({ preventScroll: true });
  });
}
