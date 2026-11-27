// Kadr — the page: wires the engine, renderer, sound, subtitles and all the controls together
(async () => {
  const $ = s => document.querySelector(s);
  const app = $('#app'), stage = $('#stage'), video = $('#video'), canvas = $('#gl');
  const cfg = await window.kadr.init();
  const S = Object.assign({}, K.DEFAULTS, cfg.settings || {});
  if (!Array.isArray(S.eq) || S.eq.length !== 10) S.eq = K.DEFAULTS.eq.slice();
  const ST = Object.assign({ recent: [], resume: {} }, cfg.state || {});
  const SUB_EXT = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'txt', 'mpl', 'smi'];
  const AUDIO_EXT = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'ac3', 'eac3', 'dts', 'ape', 'wv', 'mka', 'aiff', 'aif', 'alac', 'tta', 'mpc', 'amr', 'caf', 'weba'];
  const SPONSORS = {
    pz: 'https://prozlecenie.pl/?utm_source=kadr-player&utm_medium=app',
    cs: 'https://cyberscope.pl/?utm_source=kadr-player&utm_medium=app',
  };

  // ---------- helpers ----------
  const ext = p => (/\.([^.\\/]+)$/.exec(p || '') || [])[1]?.toLowerCase() || '';
  const baseName = p => (/^https?:/i.test(p) ? decodeURIComponent((p.split('?')[0].split('/').filter(Boolean).pop() || p)) : p.split(/[\\/]/).pop());
  const dirName = p => p.replace(/[\\/][^\\/]*$/, '');
  const titleOf = p => baseName(p).replace(/\.[^.]+$/, '');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = t => {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const saveSettings = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => window.kadr.saveSettings(S), 300); }; })();
  const saveState = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => window.kadr.saveState(ST), 500); }; })();
  const icon = K.icon;
  for (const [sel, ic] of [['#btn-menu', 'menu'], ['#b-prev', 'skip-back'], ['#b-next', 'skip-forward'], ['#b-subs', 'captions'], ['#b-audio', 'audio-lines'],
    ['#b-shot', 'camera'], ['#b-settings', 'gear'], ['#b-list', 'list-video'], ['#b-mini', 'picture-in-picture-2'], ['#b-full', 'maximize'],
    ['[data-act=close-panel]', 'x'], ['[data-act=close-list]', 'x'], ['[data-act=pl-add]', 'plus'], ['[data-act=pl-folder]', 'folder-open'],
    ['#pl-shuffle', 'shuffle'], ['#pl-repeat', 'repeat'], ['[data-act=pl-save]', 'save'], ['[data-act=pl-clear]', 'trash-2']]) {
    document.querySelectorAll(sel).forEach(el => { el.innerHTML = icon(ic); });
  }
  $('[data-act=open-files]').innerHTML = icon('file-video') + 'Otwórz pliki';
  $('[data-act=open-folder]').innerHTML = icon('folder-open') + 'Otwórz folder';
  $('[data-act=open-url]').innerHTML = icon('link') + 'Adres URL';
  $('[data-act=open-catalog]').insertAdjacentHTML('afterbegin', icon('clapperboard'));
  $('#btn-back').innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7M5 12h14"/></svg>';

  // ---------- core objects ----------
  let encList = (S._enc && S._enc.ffmpeg === cfg.ffmpeg && S._enc.list) || null;
  const pickEncoder = () => {
    const list = encList || ['libx264'];
    return S.encoder !== 'auto' && list.includes(S.encoder) ? S.encoder : list[0];
  };
  if (!encList) window.kadr.encoders().then(list => { encList = list; S._enc = { ffmpeg: cfg.ffmpeg, list }; saveSettings(); }).catch(() => { encList = ['libx264']; });
  const engine = new K.Engine(video, { base: cfg.base, token: cfg.token, settings: () => S, encoder: pickEncoder });
  const openCatalog = K.createMovieCatalog((movie, episodes = [movie], index = 0) => {
    playlist = episodes.map(entry => ({ path: entry.url, title: entry.title, catalog: true }));
    playIndex(index);
  });
  const sound = new K.AudioChain(video);
  const subsView = new K.SubtitleView($('#subs'));
  let gl = null;
  const useGL = () => S.renderer === 'gl' && gl && gl.ok;

  function setupRenderer() {
    if (S.renderer === 'gl' && !gl) {
      gl = new K.GLRenderer(canvas);
      gl.onLost = () => { osd('Utracono kontekst grafiki', 'przełączam na renderer natywny'); app.classList.add('native'); dirty = true; };
      gl.onRestored = () => { if (S.renderer === 'gl') app.classList.remove('native'); dirty = true; };
      if (!gl.ok) osd('WebGL2 niedostępny', 'używam renderera natywnego');
    }
    app.classList.toggle('native', !useGL());
    resetVideoStyle();
    dirty = true;
  }

  // per-file state
  let cur = null;          // { item, info, crop, subTracks, subSel, subDelay, cues, started }
  let playlist = [];
  let plIndex = -1;
  let dirty = true;
  let showRemaining = false;
  let remote = null;
  let movieId = 0;
  const playbackTime = () => remote ? remote.time : video.currentTime;
  const playbackDuration = () => remote ? remote.duration : engine.duration();
  const playbackPaused = () => remote ? remote.paused : video.paused;
  const seekPlayback = (t, exact) => remote ? controlMovie('seek', t) : engine.seek(t, exact);

  function movieBounds() {
    const controls = app.classList.contains('ui-visible');
    const y = Math.max(controls ? $('#titlebar').offsetHeight : 0, $('#update-notice').hidden ? 0 : Math.ceil($('#update-notice').getBoundingClientRect().bottom));
    return { controls, x: 0, y, width: innerWidth, height: innerHeight - y - (controls ? $('#controls').offsetHeight : 0) };
  }

  function closeRemote() {
    if (!remote) return;
    const id = remote.id;
    remote = null;
    app.classList.remove('catalog-movie');
    window.kadr.movieAction(id, 'close').catch(() => {});
  }

  function refreshMovieView() {
    if (!remote) return;
    const id = remote.id;
    const bounds = movieBounds();
    const old = remote.bounds;
    if (!old || bounds.width !== old.width || bounds.height !== old.height || bounds.y !== old.y || bounds.controls !== old.controls) {
      remote.bounds = bounds;
      window.kadr.movieAction(id, 'bounds', bounds).catch(() => {});
    }
    const visible = !$('#captions-dialog').open && !$('#catalog').open && !document.querySelector('.drawer.open, .modal.open') && !app.classList.contains('error');
    if (visible !== remote.visible) {
      remote.visible = visible;
      window.kadr.movieAction(id, 'visible', visible).catch(() => {});
    }
  }
  const movieObserver = new MutationObserver(refreshMovieView);
  for (const el of document.querySelectorAll('#catalog, #captions-dialog, .drawer, #modal')) movieObserver.observe(el, { attributes: true, attributeFilter: ['open', 'class'] });
  window.addEventListener('resize', refreshMovieView);

  async function controlMovie(action, value) {
    const current = remote;
    if (!current?.ready) return;
    try {
      const state = await window.kadr.movieAction(current.id, action, value);
      if (current !== remote) return;
      if (!state) throw new Error('Brak obrazu.');
      const ended = state.ended && !current.ended;
      const pausedChanged = state.paused !== current.paused;
      Object.assign(current, state);
      if (pausedChanged) { setPlayIcon(); showUI(); }
      if (app.classList.contains('ui-visible')) updateTimeUI();
      rememberPosition();
      if (ended && !generating) onEnded();
    } catch {
      if (current === remote) movieFailed();
    }
  }

  function movieFailed() {
    closeRemote();
    showUI();
    $('#error-text').textContent = 'Nie udało się odtworzyć filmu z katalogu Kadr. Otwórz katalog, aby spróbować ponownie lub wybrać inny tytuł.';
    $('[data-act=force-encode]').style.display = 'none';
    app.classList.remove('waiting');
    app.classList.add('error');
  }

  async function startCatalogMovie(item, start) {
    const current = remote = { id: ++movieId, time: 0, duration: 0, paused: true };
    app.classList.add('catalog-movie', 'ui-visible');
    seekEl.querySelector('.chapters').replaceChildren();
    setPlayIcon();
    updateTimeUI();
    try {
      if (!await window.kadr.playMovie(item.path, current.id, movieBounds(), S.muted ? 0 : S.volume)) return;
      if (current !== remote) return;
      current.ready = true;
      void applyMovieQuality(current, undefined, 6).catch(() => {});
      captionAppearance();
      refreshMovieView();
      app.classList.remove('waiting');
      showUI();
      if (start) await controlMovie('seek', start);
      while (current === remote) {
        await controlMovie('status');
        const delay = current.providerMenuOpen || (!current.paused && app.classList.contains('ui-visible')) ? 350 : 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch {
      if (current === remote) movieFailed();
    }
  }

  // ---------- OSD / tooltip ----------
  let osdTimer;
  function osd(text, sub, ms = 1500) {
    const el = $('#osd');
    el.textContent = text;
    if (sub) { const s = document.createElement('small'); s.textContent = sub; el.appendChild(s); }
    el.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function centerIcon(name) {
    const el = $('#center-icon');
    el.innerHTML = icon(name);
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  const tip = $('#tooltip');
  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.classList.remove('on'); return; }
    tip.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect();
    tip.classList.add('on');
    const w = tip.offsetWidth;
    tip.style.left = clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6) + 'px';
    tip.style.top = (r.top - 34 < 4 ? r.bottom + 8 : r.top - 34) + 'px';
  });
  document.addEventListener('mousedown', () => tip.classList.remove('on'));

  // ---------- UI auto-hide ----------
  let hideTimer, nativeMenuOpen = false;
  // Chromium can leave :hover on the toolbar when a native movie view takes the pointer.
  let pointerOverControls = false;
  const overUI = () => pointerOverControls || !!document.querySelector('.drawer.open, .modal.open');
  function showUI() {
    if (!app.classList.contains('ui-visible')) { app.classList.add('ui-visible'); updateTimeUI(); layoutSubs(); refreshMovieView(); window.kadr.overlay({ color: '#00000000', symbolColor: '#d7dbe4', height: 38 }); }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(maybeHide, app.classList.contains('mini') ? 1600 : 2600);
  }
  function maybeHide() {
    if (playbackPaused() || app.classList.contains('empty')) return;
    if (overUI() || document.querySelector('dialog[open]') || nativeMenuOpen || remote?.providerMenuOpen || seekDrag || volDrag) { hideTimer = setTimeout(maybeHide, 1200); return; }
    app.classList.remove('ui-visible');
    tip.classList.remove('on');
    layoutSubs();
    refreshMovieView();
    if (!app.classList.contains('fullscreen')) window.kadr.overlay({ color: '#00000000', symbolColor: '#00000000', height: 38 });
  }
  document.addEventListener('pointermove', e => {
    pointerOverControls = !!e.target.closest('#controls, #titlebar');
    showUI();
  });
  document.addEventListener('pointerout', e => { if (!e.relatedTarget) pointerOverControls = false; });
  app.classList.add('ui-visible');

  // ---------- layout ----------
  const parseAspect = a => { const m = /^([\d.]+):([\d.]+)$/.exec(a); return m ? +m[1] / +m[2] : 0; };
  let rect = null;     // current picture rectangle in CSS px (stage coordinates)
  function computeRect() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !W || !H) return null;
    const crop = (cur && cur.crop) || { x: 0, y: 0, w: 1, h: 1 };
    const rot = (S.rotate / 90) % 2 === 1;
    let ar = parseAspect(S.aspect) || (vw * crop.w) / (vh * crop.h);
    if (rot) ar = 1 / ar;
    const bh = rot ? vw * crop.w : vh * crop.h;
    const bw = bh * ar;
    const dpr = devicePixelRatio || 1;
    let w, h;
    const fit = Math.min(W / bw, H / bh);
    switch (S.fit) {
      case 'fill': { const k = Math.max(W / bw, H / bh); w = bw * k; h = bh * k; break; }
      case 'stretch': w = W; h = H; break;
      case 'native': w = bw / dpr; h = bh / dpr; break;
      case 'integer': { const k = fit * dpr >= 1 ? Math.floor(fit * dpr) / dpr : fit; w = bw * k; h = bh * k; break; }
      default: w = bw * fit; h = bh * fit;
    }
    w *= S.zoom; h *= S.zoom;
    const pan = (cur && cur.pan) || { x: 0, y: 0 };
    return { x: (W - w) / 2 + pan.x * W, y: (H - h) / 2 + pan.y * H, w, h, W, H, crop, rot };
  }
  function resetVideoStyle() {
    for (const p of ['left', 'top', 'width', 'height', 'transform', 'clipPath', 'filter']) video.style[p] = '';
  }
  function applyNative(r) {
    const crop = r.crop;
    const cw = r.rot ? r.h : r.w, ch = r.rot ? r.w : r.h;
    const vw = cw / crop.w, vh = ch / crop.h;
    const dx = (crop.x + crop.w / 2 - 0.5) * vw, dy = (crop.y + crop.h / 2 - 0.5) * vh;
    video.style.width = vw + 'px'; video.style.height = vh + 'px';
    video.style.left = (r.x + r.w / 2 - vw / 2) + 'px'; video.style.top = (r.y + r.h / 2 - vh / 2) + 'px';
    video.style.transform = `rotate(${S.rotate}deg) scale(${S.flipH ? -1 : 1}, ${S.flipV ? -1 : 1}) translate(${-dx}px, ${-dy}px)`;
    video.style.clipPath = (crop.w < 1 || crop.h < 1) ? `inset(${crop.y * 100}% ${(1 - crop.x - crop.w) * 100}% ${(1 - crop.y - crop.h) * 100}% ${crop.x * 100}%)` : '';
    const f = [];
    if (S.bright) f.push(`brightness(${1 + S.bright})`);
    if (S.contr !== 1) f.push(`contrast(${S.contr})`);
    if (S.sat !== 1) f.push(`saturate(${S.sat})`);
    if (S.hue) f.push(`hue-rotate(${S.hue}deg)`);
    video.style.filter = f.join(' ');
  }
  function layoutSubs() {
    const el = $('#subs');
    const r = rect;
    const H = stage.clientHeight, W = stage.clientWidth;
    let top = 0, left = 0, width = W, height = H;
    if (r && !app.classList.contains('audio-only')) {
      left = Math.max(0, r.x); top = Math.max(0, r.y);
      width = Math.min(W, r.x + r.w) - left; height = Math.min(H, r.y + r.h) - top;
      if (S.subMargins && H - (top + height) > H * 0.06) height = H - top;
    }
    const size = Math.max(12, (r ? Math.min(height, H) : H) * S.subSize / 100);
    let bottom = height * S.subPos / 100;
    if (S.subMargins && r && H - (r.y + r.h) > H * 0.06) bottom = Math.max(height * 0.015, (H - (r.y + r.h)) / 2 - size / 2);
    const ctl = app.classList.contains('ui-visible') && !app.classList.contains('empty') ? 96 : 0;
    const gapBelow = H - (top + height);
    if (ctl && bottom + gapBelow < ctl) bottom = ctl - gapBelow;
    Object.assign(el.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    el.style.setProperty('--sub-size', size.toFixed(1) + 'px');
    el.style.setProperty('--sub-bottom', bottom.toFixed(1) + 'px');
  }
  function applySubStyle() {
    const el = $('#subs');
    el.style.setProperty('--sub-color', S.subColor);
    el.style.setProperty('--sub-outline', S.subOutline + 'px');
    el.style.setProperty('--sub-bg', `rgba(0,0,0,${S.subBg})`);
    el.style.setProperty('--sub-font', `'${S.subFont}'`);
    el.style.setProperty('--sub-weight', S.subBold ? 700 : 500);
    layoutSubs();
  }
  function resizeCanvas() {
    const dpr = (devicePixelRatio || 1) * (+S.renderScale || 1);
    const w = Math.max(1, Math.round(stage.clientWidth * dpr)), h = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return dpr;
  }
  new ResizeObserver(() => { dirty = true; }).observe(stage);

  // ---------- render loop ----------
  let newFrame = false, frameMeta = null, prevMedia = 0, curMedia = 0;
  let clockS = null, lastRate = 1, vsync = 1 / 60;
  const vsyncSamples = [];
  let lastRaf = 0, lastDraw = 0, drawCount = 0, drawFps = 0, drawFpsT = performance.now();
  function onVideoFrame(now, meta) {
    video.requestVideoFrameCallback(onVideoFrame);
    newFrame = true;
    frameMeta = meta;
    prevMedia = curMedia; curMedia = meta.mediaTime;
    const r = video.playbackRate || 1;
    const s = meta.mediaTime - r * (meta.expectedDisplayTime / 1000);
    if (clockS === null || Math.abs(s - clockS) > 0.15 || r !== lastRate) clockS = s; else clockS += (s - clockS) * 0.06;
    lastRate = r;
    if (useGL()) {
      // with a frame limit, skip processing frames that come too fast (e.g. 120 fps video on battery)
      const lim = +S.fpsLimit;
      if (lim && now - lastProcess < 1000 / lim - 2) return;
      if (gl.upload(video)) render(now, true);
    }
  }
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onVideoFrame);

  // ---- automatic relief for weak GPUs: when Chromium keeps dropping frames, step the renderer down (this session only)
  let perfLevel = 0;
  const PERF_STEPS = ['pomniejszanie bez światła liniowego', 'skalowanie Catmull-Rom zamiast ' + '{s}', 'płynny ruch wyłączony', 'skalowanie dwuliniowe'];
  const effLinear = () => S.linear && perfLevel < 1;
  const effScaler = () => (perfLevel >= 4 && S.scaler !== 'nearest' ? 'bilinear' : perfLevel >= 2 && ['lanczos', 'spline36'].includes(S.scaler) ? 'catrom' : S.scaler);
  const effSmooth = () => S.smooth && perfLevel < 3;
  let perfQ = null, perfBad = 0;
  setInterval(() => {
    if (!useGL() || video.paused || !cur || !cur.info || !cur.info.video.length || !video.getVideoPlaybackQuality || perfLevel >= 4) { perfQ = null; return; }
    const q = video.getVideoPlaybackQuality();
    if (perfQ) {
      const total = q.totalVideoFrames - perfQ.totalVideoFrames, dropped = q.droppedVideoFrames - perfQ.droppedVideoFrames;
      if (total > 30 && dropped / total > 0.06) perfBad++; else perfBad = 0;
      if (perfBad >= 2) {
        perfBad = 0;
        // skip steps that change nothing with the current settings
        do { perfLevel++; } while (perfLevel < 4 && ((perfLevel === 1 && !S.linear) || (perfLevel === 2 && !['lanczos', 'spline36'].includes(S.scaler)) || (perfLevel === 3 && !S.smooth)));
        osd('Odciążam kartę graficzną', PERF_STEPS[perfLevel - 1].replace('{s}', S.scaler === 'spline36' ? 'Spline36' : 'Lanczos'), 3000);
        applySound();
        dirty = true;
      }
    }
    perfQ = { totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames };
  }, 3000);

  const smoothOn = () => effSmooth() && !video.paused && !!cur && !!cur.info && cur.info.video.length > 0;
  function smoothMix(now) {
    if (!smoothOn()) return 1;
    const fps = K.streamFps(engine.sel.video) || 24;
    const fd = 1 / (fps * (video.playbackRate || 1));
    const tNow = clockS + (video.playbackRate || 1) * now / 1000;
    const tDisp = tNow - fd;
    return clamp((tDisp + vsync - curMedia) / vsync, 0, 1);
  }
  let lastProcess = 0, lastDst = null;
  // full processing of the current frame (scaling, sharpening…) — once per video frame or after a change
  function render(now, isNewFrame) {
    if (!useGL() || !video.videoWidth) return;
    const dpr = resizeCanvas();
    rect = computeRect();
    if (!rect) return;
    const dst = { x: rect.x * dpr, y: rect.y * dpr, w: rect.w * dpr, h: rect.h * dpr };
    gl.process({
      dst, crop: rect.crop, rot: S.rotate, flipH: S.flipH, flipV: S.flipV,
      scaler: effScaler(), antiring: S.antiring, sharpen: S.sharpen, deband: S.deband, debandStrength: S.debandStrength,
      linear: effLinear(), color: { bright: S.bright, contr: S.contr, sat: S.sat, gamma: S.gamma, hue: S.hue },
    }, isNewFrame);
    lastDst = dst;
    lastProcess = now;
    gl.present(dst, smoothMix(now), S.dither);
    lastDraw = now; drawCount++;
    dirty = false;
  }
  // cheap: blend the two newest processed frames for this screen refresh
  function present(now) {
    const lim = +S.fpsLimit;
    if (lim && now - lastDraw < 1000 / lim - 2) return;
    if (!lastDst) return;
    gl.present(lastDst, smoothMix(now), S.dither);
    lastDraw = now; drawCount++;
  }
  function loop(now) {
    renderFrame = 0;
    if (!cur || cur.item.catalog) { lastRaf = 0; return; }
    renderFrame = requestAnimationFrame(loop);
    if (lastRaf) {
      const d = (now - lastRaf) / 1000;
      if (d > 0.003 && d < 0.1) { vsyncSamples.push(d); if (vsyncSamples.length > 60) vsyncSamples.shift(); }
      if (vsyncSamples.length > 10) { const s = vsyncSamples.slice().sort((a, b) => a - b); vsync = s[s.length >> 1]; }
    }
    lastRaf = now;
    if (now - drawFpsT > 1000) { drawFps = drawCount * 1000 / (now - drawFpsT); drawCount = 0; drawFpsT = now; }
    if (cur && cur.info && cur.info.video.length) {
      if (useGL()) {
        if (dirty) { if (gl.texW) render(now, false); else if (video.readyState >= 2 && gl.upload(video)) render(now, true); }
        else if (smoothOn()) present(now);
      } else if (dirty) {
        rect = computeRect();
        if (rect) applyNative(rect);
        dirty = false;
      }
    }
    if (rectChanged()) layoutSubs();
    if (cur && cur.cues) subsView.render(video.currentTime - (cur.subDelay || 0));
    if (app.classList.contains('audio-only')) drawViz();
    if (now - lastUi > 120) { lastUi = now; if (app.classList.contains('ui-visible')) updateTimeUI(); rememberPosition(); }
    if (app.classList.contains('stats') && now - lastStats > 500) { lastStats = now; updateStats(); }
  }
  let lastUi = 0, lastStats = 0, lastRectKey = '';
  function rectChanged() {
    const k = rect ? `${rect.x|0},${rect.y|0},${rect.w|0},${rect.h|0},${stage.clientWidth},${stage.clientHeight}` : `${stage.clientWidth},${stage.clientHeight}`;
    if (k === lastRectKey) return false;
    lastRectKey = k; return true;
  }
  let renderFrame = 0;

  // music visualiser
  const viz = $('#viz');
  let spec = null;
  function drawViz() {
    spec = sound.spectrum(spec);
    const w = viz.clientWidth * devicePixelRatio, h = viz.clientHeight * devicePixelRatio;
    if (viz.width !== w || viz.height !== h) { viz.width = w; viz.height = h; }
    const g = viz.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (!spec) return;
    const bars = 72, grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, 'rgba(255,95,69,.9)'); grad.addColorStop(1, 'rgba(255,176,58,.25)');
    g.fillStyle = grad;
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor(Math.pow(i / bars, 1.7) * spec.length * 0.7), b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * spec.length * 0.7));
      let m = 0; for (let j = a; j < b; j++) m = Math.max(m, spec[j]);
      const bh = (m / 255) * h * 0.95;
      g.fillRect(i * bw + bw * 0.18, h - bh, bw * 0.64, bh);
    }
  }

  // ---------- time / seek bar ----------
  const seekEl = $('#seek');
  let seekDrag = false;
  function updateTimeUI() {
    if (!cur) return;
    const d = playbackDuration(), t = seekDrag ? seekDragT : playbackTime();
    const clock = $('#t-cur'), duration = $('#t-dur');
    const timeText = fmt(t), durationText = d ? (showRemaining ? '-' + fmt(d - t) : fmt(d)) : '—';
    if (clock.textContent !== timeText) clock.textContent = timeText;
    if (duration.textContent !== durationText) duration.textContent = durationText;
    const p = d ? clamp(t / d, 0, 1) * 100 : 0;
    seekEl.querySelector('.played').style.width = p + '%';
    seekEl.querySelector('.knob').style.left = p + '%';
    const buf = seekEl.querySelector('.buf');
    const ranges = engine.bufferedRanges();
    const key = ranges.map(r => r.map(x => x.toFixed(0)).join('-')).join(',');
    if (d && buf.dataset.k !== key) {
      buf.dataset.k = key;
      buf.textContent = '';
      for (const [a, b] of ranges) { const i = document.createElement('i'); i.style.left = (a / d * 100) + '%'; i.style.width = ((b - a) / d * 100) + '%'; buf.appendChild(i); }
    }
  }
  let lastResume = 0;
  function rememberPosition() {
    const now = performance.now();
    if (!playbackPaused() && now - lastResume >= 5000) { lastResume = now; saveResume(); }
  }
  $('#time').onclick = () => { showRemaining = !showRemaining; updateTimeUI(); };
  let seekDragT = 0;
  const seekTimeAt = x => { const r = seekEl.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1) * playbackDuration(); };
  seekEl.addEventListener('lostpointercapture', () => { if (seekDrag) { seekDrag = false; seekEl.classList.remove('drag'); showUI(); } });
  let liveSeekT = 0;
  seekEl.addEventListener('pointerdown', e => {
    if (!cur || !playbackDuration() || e.button !== 0) return;
    seekDrag = true; seekEl.classList.add('drag'); seekEl.setPointerCapture(e.pointerId);
    seekDragT = seekTimeAt(e.clientX); updateTimeUI(); hoverTip(e.clientX);
  });
  seekEl.addEventListener('pointermove', e => {
    hoverTip(e.clientX);
    if (!seekDrag) return;
    seekDragT = seekTimeAt(e.clientX); updateTimeUI();
    if (!remote && engine.mode === 'direct' && performance.now() - liveSeekT > 120) { liveSeekT = performance.now(); video.currentTime = seekDragT; }
  });
  seekEl.addEventListener('pointerup', e => {
    if (!seekDrag) return;
    seekDrag = false; seekEl.classList.remove('drag');
    seekPlayback(seekTimeAt(e.clientX), true);
  });
  seekEl.addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); seekBy(e.deltaY < 0 ? S.seekStep : -S.seekStep); }, { passive: false });

  // hover preview
  const tipEl = $('#seek-tip'), tipImg = tipEl.querySelector('img');
  const thumbCache = new Map();
  let thumbCtl = null, thumbTimer = null, thumbKey = null;
  function hoverTip(x) {
    if (!cur || !playbackDuration()) return;
    const r = seekEl.getBoundingClientRect();
    const t = seekTimeAt(x);
    tipEl.style.left = clamp(x - r.left, 100, r.width - 100) + 'px';
    tipEl.querySelector('.t').textContent = fmt(t);
    const ch = cur.info && cur.info.chapters.find(c => t >= c.start && t < c.end);
    tipEl.querySelector('.ch').textContent = ch ? ch.title : '';
    const local = cur.item && !/^https?:/i.test(cur.item.path);
    if (!S.thumbs || !local || !cur.info || !cur.info.video.length) { tipImg.classList.remove('on'); return; }
    const step = Math.max(2, engine.duration() / 400);
    const key = Math.round(t / step) * step;
    if (thumbCache.has(key)) { tipImg.src = thumbCache.get(key); tipImg.classList.add('on'); return; }
    if (key === thumbKey) return;
    thumbKey = key;
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(async () => {
      if (thumbCtl) thumbCtl.abort();
      const ctl = thumbCtl = new AbortController();
      try {
        const res = await fetch(engine.url('/thumb', { p: cur.item.path, t: key.toFixed(2), w: 192 }), { signal: ctl.signal });
        if (!res.ok) return;
        const url = URL.createObjectURL(await res.blob());
        thumbCache.set(key, url);
        if (thumbCache.size > 240) { const [k, u] = thumbCache.entries().next().value; URL.revokeObjectURL(u); thumbCache.delete(k); }
        if (thumbKey === key) { tipImg.src = url; tipImg.classList.add('on'); }
      } catch {}
    }, 70);
  }
  function clearThumbs() { for (const u of thumbCache.values()) URL.revokeObjectURL(u); thumbCache.clear(); thumbKey = null; tipImg.classList.remove('on'); }

  // ---------- volume ----------
  const volEl = $('#vol-slider');
  let volDrag = false;
  function applyVolume() {
    sound.set({ volume: S.volume, muted: S.muted });
    if (remote?.ready) controlMovie('volume', S.muted ? 0 : S.volume);
    const max = +S.volumeMax || 1;
    const p = clamp(S.volume / max, 0, 1) * 100;
    volEl.querySelector('.fill').style.width = p + '%';
    volEl.querySelector('.knob').style.left = p + '%';
    volEl.classList.toggle('boost', max > 1);
    volEl.style.setProperty('--b100', (100 / max) + '%');
    volEl.querySelector('.max100').style.left = (100 / max) + '%';
    $('#vol-text').textContent = S.muted ? 'wycisz.' : Math.round(S.volume * 100) + '%';
    $('#b-mute').innerHTML = icon(S.muted || S.volume === 0 ? 'volume-x' : S.volume < 0.5 ? 'volume-1' : 'volume-2');
  }
  function setVolume(v, show = true) {
    S.volume = clamp(Math.round(v * 100) / 100, 0, +S.volumeMax || 1);
    if (S.volume > 0) S.muted = false;
    applyVolume(); saveSettings();
    if (show) osd(`Głośność ${Math.round(S.volume * 100)}%`);
  }
  const volAt = x => { const r = volEl.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1) * (+S.volumeMax || 1); };
  volEl.addEventListener('pointerdown', e => { volDrag = true; volEl.setPointerCapture(e.pointerId); setVolume(volAt(e.clientX), false); });
  volEl.addEventListener('pointermove', e => { if (volDrag) setVolume(volAt(e.clientX), false); });
  volEl.addEventListener('lostpointercapture', () => { volDrag = false; showUI(); });
  $('#vol').addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); setVolume(S.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });
  $('#b-mute').onclick = () => { S.muted = !S.muted; applyVolume(); saveSettings(); osd(S.muted ? 'Wyciszono' : `Głośność ${Math.round(S.volume * 100)}%`); };

  // ---------- playback controls ----------
  function togglePlay() {
    if (!cur) return;
    if (remote) { controlMovie('toggle'); return; }
    sound.ensure(); sound.resume();
    if (video.paused) { engine.play(); centerIcon('play'); } else { engine.pause(); centerIcon('pause'); }
  }
  function seekBy(d) {
    if (!cur || (!remote && !engine.mode)) return;
    const t = clamp(playbackTime() + d, 0, playbackDuration() || Infinity);
    if (remote) controlMovie('seek-by', d); else seekPlayback(t, Math.abs(d) < 3);
    osd(`${d > 0 ? '+' : '−'}${Math.abs(d)} s`, fmt(t) + ' / ' + fmt(playbackDuration()), 900);
  }
  function setSpeed(r) {
    if (remote) return;
    r = clamp(Math.round(r * 100) / 100, 0.1, 4);
    video.playbackRate = r;
    video.defaultPlaybackRate = r;
    osd(`Prędkość ${r}×`);
  }
  function frameStep(dir) {
    if (!cur || !cur.info || !cur.info.video.length) return;
    engine.pause();
    const fps = K.streamFps(engine.sel.video) || 25;
    const t = clamp(video.currentTime + dir / fps, 0, engine.duration());
    if (engine.mode === 'direct') video.currentTime = t; else engine.seek(t, true);
    osd(dir > 0 ? 'Następna klatka' : 'Poprzednia klatka', fmt(t) + ' · ' + (t % 1).toFixed(3).slice(1), 800);
  }
  $('#b-play').onclick = togglePlay;
  $('#b-prev').onclick = () => playRelative(-1);
  $('#b-next').onclick = () => playRelative(1);
  $('#b-full').onclick = () => window.kadr.fullscreen();
  $('#b-mini').onclick = () => toggleMini();
  $('#b-shot').onclick = () => screenshot();
  $('#b-settings').onclick = () => qualityMenu().catch(() => osd('Nie udało się odczytać jakości filmu.'));
  $('#b-list').onclick = () => toggleList();
  $('#b-speed').onclick = () => popup(speedMenu());
  $('#b-subs').onclick = () => openCaptions();
  $('#b-audio').onclick = () => popup(audioMenu());
  $('#btn-menu').onclick = () => popup(mainMenu());
  $('#btn-back').onclick = returnToCatalog;
  function setPlayIcon() {
    $('#b-play').innerHTML = icon(playbackPaused() ? 'play' : 'pause');
    $('#b-speed').textContent = (video.playbackRate || 1) + '×';
  }
  setPlayIcon();

  async function toggleMini(force) {
    const on = force !== undefined ? force : !app.classList.contains('mini');
    const r = await window.kadr.mini(on);
    app.classList.toggle('mini', r);
    dirty = true;
  }
  window.kadr.onFullscreen(v => { app.classList.toggle('fullscreen', v); $('#b-full').innerHTML = icon(v ? 'minimize' : 'maximize'); dirty = true; });

  // ---------- stage mouse ----------
  let clickTimer = null;
  stage.addEventListener('click', e => {
    if (e.target.closest('#welcome, #error-box, .drawer')) return;
    if (app.classList.contains('empty')) return;
    if (document.querySelector('.drawer.open')) { closeDrawers(); return; }
    if (!S.clickPause) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(togglePlay, 230);
  });
  stage.addEventListener('dblclick', e => {
    if (e.target.closest('#welcome, #error-box, .drawer')) return;
    clearTimeout(clickTimer);
    if (!app.classList.contains('empty')) window.kadr.fullscreen();
  });
  stage.addEventListener('wheel', e => {
    if (e.target.closest('#welcome, .drawer')) return;
    if (app.classList.contains('empty')) return;
    e.preventDefault();
    if (e.ctrlKey) { setSetting('zoom', clamp(Math.round((S.zoom + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100, 0.5, 3)); osd(`Powiększenie ${Math.round(S.zoom * 100)}%`); }
    else setVolume(S.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: false });
  app.addEventListener('contextmenu', e => {
    if (e.target.closest('input, select')) return;
    e.preventDefault();
    popup(mainMenu());
  });

  // ---------- menus ----------
  const popup = async (items, position) => {
    nativeMenuOpen = true;
    showUI();
    let id;
    try { id = await window.kadr.menu(strip(items), position); }
    finally { nativeMenuOpen = false; showUI(); }
    if (!id) return;
    const f = findAction(items, id);
    if (f) f();
  };
  let menuSeq = 0;
  function mk(label, run, extra = {}) { return Object.assign({ id: 'm' + (++menuSeq), label, run }, extra); }
  const sep = { type: 'separator' };
  function strip(items) { return items.map(i => (i.type === 'separator' ? i : { id: i.id, label: i.label, type: i.type, checked: i.checked, enabled: i.enabled, accelerator: i.accelerator, submenu: i.submenu && strip(i.submenu) })); }
  function findAction(items, id) {
    for (const i of items) { if (i.id === id) return i.run; if (i.submenu) { const r = findAction(i.submenu, id); if (r) return r; } }
    return null;
  }
  const radio = (label, checked, run) => mk(label, run, { type: 'radio', checked });
  const check = (label, checked, run, acc) => mk(label, run, { type: 'checkbox', checked, accelerator: acc });

  const profileNames = { ...Object.fromEntries(Object.entries(K.qualityProfiles).map(([id,p]) => [id,p.label])), custom: 'Własne' };
  const profileKeys = Object.keys(K.localProfile('best'));
  const snapshotQuality = () => Object.fromEntries(profileKeys.map(key => [key, S[key]]));
  if (!S.localProfileId) {
    S.localProfileId = cfg.settings && profileKeys.some(key => key in cfg.settings && cfg.settings[key] !== K.DEFAULTS[key]) ? 'custom' : 'best';
    S.customQuality = snapshotQuality();
    if (S.localProfileId === 'best') Object.assign(S, K.localProfile('best'));
  }
  function chooseLocal(id, patch = {}) {
    if (S.localProfileId === 'custom') S.customQuality = snapshotQuality();
    const next = id === 'custom' ? { ...S.customQuality, ...patch } : K.localProfile(id);
    const previous = snapshotQuality();
    Object.assign(S, next, { localProfileId: id });
    if (id === 'custom') S.customQuality = snapshotQuality();
    saveSettings();
    perfLevel = 0;                       // an explicit choice clears the automatic relief of this session
    const relieved = !!engine.autoMaxHeight;
    engine.autoMaxHeight = 0; engine.stalls = [];
    if (previous.renderer !== S.renderer) setupRenderer();
    dirty = true;
    if (engine.info && engine.mode && !remote) {
      const mode = engine.plan().mode;
      if (mode !== engine.mode || (mode === 'encode' && (relieved || ['quality','maxHeight','interp'].some(k => previous[k] !== S[k])))) {
        engine.wantPlay = !video.paused;
        clearTimeout(replanTimer);
        engine.replan();
      }
    }
  }
  async function applyMovieQuality(movie, id = S.movieProfileId || 'best', retries = 0) {
    const cap = id === 'custom' ? S.customMovieCap ?? -1 : K.qualityProfiles[id].cap;
    // the provider's player may list its variants a moment after playback starts
    for (let i = 0; ; i++) {
      const r = await window.kadr.movieAction(movie.id, 'quality', cap);
      if (!r || remote !== movie || r.heights.length || i >= retries) return r;
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  const SCALER_NAMES = { lanczos: 'Lanczos', spline36: 'Spline36', mitchell: 'Mitchell', catrom: 'Catmull-Rom', bilinear: 'dwuliniowe', nearest: 'najbliższy sąsiad' };
  const MODE_NAMES = { direct: 'bez konwersji', copy: 'przepakowanie bez utraty jakości', encode: 'konwersja FFmpeg' };
  // what the current profile really does right now (shown at the top of the gear menu)
  function qualityEffect(movie, state) {
    const id = movie ? S.movieProfileId || 'best' : S.localProfileId;
    const name = profileNames[id] || profileNames.best;
    if (movie) {
      const h = state?.height;
      const heights = state?.heights || [];
      return [name + (h ? ' · ' + h + 'p' : ''),
        heights.length > 1 ? 'Warianty źródła: ' + heights.map(x => x + 'p').join(', ')
          : heights.length === 1 ? 'Źródło ma jedną jakość (' + heights[0] + 'p)'
          : state?.auto ? 'Źródło oferuje tylko automat' : 'Źródło nie udostępnia wyboru jakości'];
    }
    const h = video.videoHeight;
    const scaled = lastDst && video.videoWidth && (Math.abs(lastDst.w - video.videoWidth) > 1 || Math.abs(lastDst.h - video.videoHeight) > 1);
    const rend = useGL() ? 'WebGL2 · ' + (scaled ? SCALER_NAMES[effScaler()] || effScaler() : 'bez skalowania') : 'renderer natywny';
    const path = engine.mode ? MODE_NAMES[engine.mode] + (engine.mode === 'encode' ? ' (' + ({ max: 'maks.', balanced: 'zrównoważona', fast: 'szybka' }[S.quality] || S.quality) + ')' : '') : '';
    return [name + (h ? ' · ' + h + 'p' : ''), [rend, path].filter(Boolean).join(' · ')];
  }
  // a native menu sits above the embedded movie view too; place it just above the bar, right-aligned with the gear
  function menuAbove(items) {
    // Windows 11 menu metrics (DIP): 28 per item, 17 per separator, ~23 of padding. If the estimate were too small the
    // menu would not fit under the anchor and Windows would flip it upwards over the video, so it errs on the large side.
    const n = items.filter(i => i.type !== 'separator').length, seps = items.length - n;
    const h = n * 28 + seps * 17 + 24;
    const r = $('#b-settings').getBoundingClientRect(), bar = $('#controls').getBoundingClientRect();
    return { x: Math.max(0, Math.round(r.right - 300)), y: Math.max(0, Math.round(Math.min(r.top, bar.top) - h - 2)) };
  }
  async function qualityMenu() {
    const movie = remote, item = cur;
    const id = movie ? S.movieProfileId || 'best' : S.localProfileId;
    const state = movie?.ready ? await window.kadr.movieAction(movie.id, 'quality') : null;
    if (movie !== remote || item !== cur) return;
    const items = qualityEffect(movie, state).map(t => mk(t, null, { enabled: false }));
    items.push(sep);
    const choose = async (key, cap) => {
      if (item !== cur || movie !== remote) return;
      if (!movie) { chooseLocal(key); return; }
      if (cap != null) S.customMovieCap = cap;
      const result = await applyMovieQuality(movie, key);
      if (!result || remote !== movie) return;
      S.movieProfileId = key;
      saveSettings();
      const [a] = qualityEffect(movie, result);
      osd('Jakość: ' + a);
    };
    for (const [key, p] of Object.entries(K.qualityProfiles)) items.push(radio(p.label, id === key, () => choose(key)));
    items.push(radio('Własne…', id === 'custom', async () => {
      await choose('custom');
      if (item === cur && movie === remote) await customQualityMenu(movie, movie ? await window.kadr.movieAction(movie.id, 'quality') : null);
    }));
    if (!movie) items.push(sep, mk('Ustawienia zaawansowane…', () => openPanel('picture')));
    await popup(items, menuAbove(items));
  }
  // "Własne…": only the parameters that act in the current mode
  async function customQualityMenu(movie, state) {
    const items = [];
    if (movie) {
      const capNow = S.customMovieCap ?? -1;
      const pick = cap => async () => {
        S.customMovieCap = cap; S.movieProfileId = 'custom'; saveSettings();
        const r = await applyMovieQuality(movie, 'custom');
        if (r && remote === movie) osd('Jakość: ' + qualityEffect(movie, r)[0]);
      };
      if (state?.auto) items.push(radio('Automatycznie', capNow === -1, pick(-1)));
      for (const h of (state?.heights || []).slice().reverse()) items.push(radio(h + 'p', capNow === h, pick(h)));
      if (!items.length) items.push(mk('Źródło nie udostępnia wyboru jakości', null, { enabled: false }));
    } else {
      const set = patch => () => chooseLocal('custom', patch);
      items.push(mk('Renderowanie', null, { enabled: false }));
      items.push(radio('Natywny (najlżejszy)', S.renderer === 'native', set({ renderer: 'native' })));
      for (const sc of ['lanczos', 'catrom', 'bilinear']) items.push(radio('WebGL2 · ' + SCALER_NAMES[sc], S.renderer === 'gl' && S.scaler === sc, set({ renderer: 'gl', scaler: sc })));
      if (S.renderer === 'gl') items.push(check('Pomniejszanie w świetle liniowym', !!S.linear, set({ linear: !S.linear })));
      if (engine.mode === 'encode') {
        items.push(sep, mk('Konwersja FFmpeg (ten plik jej wymaga)', null, { enabled: false }));
        for (const [q, label] of [['max', 'Jakość maksymalna'], ['balanced', 'Zrównoważona'], ['fast', 'Szybka (najlżejsza)']]) items.push(radio(label, S.quality === q, set({ quality: q })));
        items.push(sep);
        for (const [hgt, label] of [[0, 'Rozdzielczość źródła'], [1080, 'Do 1080p'], [720, 'Do 720p'], [480, 'Do 480p']]) items.push(radio(label, (+S.maxHeight || 0) === hgt, set({ maxHeight: hgt })));
      }
      items.push(sep, mk('Ustawienia zaawansowane…', () => openPanel('picture')));
    }
    await popup(items, menuAbove(items));
  }

  function speedMenu() {
    const r = video.playbackRate || 1;
    return [0.25, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 3, 4].map(v => radio(v === 1 ? 'Normalna (1×)' : v + '×', Math.abs(r - v) < 0.001, () => setSpeed(v)))
      .concat([sep, check('Zachowaj ton głosu', S.preservesPitch, () => setSetting('preservesPitch', !S.preservesPitch))]);
  }
  function audioMenu() {
    if (!cur || !cur.info) return [mk('Brak pliku', null, { enabled: false })];
    const list = cur.info.audio;
    const items = list.length ? list.map((a, i) => radio(trackLabel(a, i, 'Ścieżka'), engine.sel.audio === a, () => { engine.setAudio(a); osd('Dźwięk: ' + trackLabel(a, i, 'Ścieżka')); })) : [mk('Brak ścieżek dźwiękowych', null, { enabled: false })];
    items.push(sep);
    const devs = sinkList.length ? sinkList : [{ id: 'default', label: 'Domyślne urządzenie' }];
    items.push(mk('Urządzenie wyjściowe', null, { submenu: devs.map(d => radio(d.label, (S.sink || 'default') === d.id, () => setSetting('sink', d.id))) }));
    items.push(check('Wyrównywanie głośności (tryb nocny)', S.normalize, () => setSetting('normalize', !S.normalize)));
    items.push(check('Wyraźne dialogi', S.dialog, () => setSetting('dialog', !S.dialog)));
    items.push(check('Korektor graficzny', S.eqOn, () => setSetting('eqOn', !S.eqOn)));
    items.push(mk('Ustawienia dźwięku…', () => openPanel('audio')));
    return items;
  }
  const captionDialog = $('#captions-dialog');
  const captionStatus = $('#captions-status');
  let generating = false;
  let captionSession = 0;
  function closeCaptions() {
    if (captionDialog.open) captionDialog.close();
  }
  captionDialog.addEventListener('close', async () => {
    const playback = returnPlayback;
    returnPlayback = null;
    ++pickerRevision;
    captionSession++;
    if (generating) await window.kadr.cancelCaptions().catch(() => {});
    if (playback?.movie) await window.kadr.movieAction(playback.movie.id, 'caption-dismiss').catch(() => {});
    await playback?.paused;
    if (playback?.resume && cur === playback.c && !captionDialog.open) {
      if (playback.movie === remote && remote) await window.kadr.movieAction(remote.id, 'play').catch(() => {});
      else if (!remote && !playback.movie) video.play().catch(() => {});
    }
    if (!captionDialog.open) $('#b-subs').focus({ preventScroll: true });
  });
  $('#captions-close').onclick = closeCaptions;
  $('#captions-get-key').onclick = () => window.kadr.external('https://console.groq.com/keys');
  function captionError(error) {
    return String(error.message || error).split('Error: ').pop().slice(0, 220);
  }
  let pickerRevision = 0, returnPlayback = null;
  const languages = $('#captions-lang'), versions = $('#captions-version');
  const names = new Intl.DisplayNames(['pl'], { type: 'language' });
  function language(code) {
    const known = K.langName(code);
    if (known && known !== code) return known;
    try { return code && code !== 'und' ? names.of(code) : 'Inne'; } catch { return code || 'Inne'; }
  }
  function captionAppearance() {
    const preview = $('#captions-preview span');
    preview.style.fontSize = S.subSize * 3.5 + 'px';
    preview.style.backgroundColor = 'rgba(0,0,0,' + S.subBg + ')';
    if (remote?.ready) window.kadr.movieAction(remote.id, 'caption-style', {
      size: S.subSize, bg: S.subBg, delay: cur?.subDelay || 0
    }).catch(e => { captionStatus.textContent = captionError(e); });
  }
  for (const [id, setting] of [['size','subSize'], ['bg','subBg']]) {
    $('#captions-' + id).oninput = e => setSetting(setting, Number(e.target.value));
  }
  $('#captions-delay').oninput = e => {
    if (cur && e.target.value !== '' && e.target.validity.valid) subDelay(+e.target.value - (cur.subDelay || 0));
  };
  async function generationHelp() {
    const cloud = $('#captions-engine').value === 'groq';
    $('#captions-cloud').hidden = !cloud;
    const ready = !cloud && await window.kadr.captionModelReady().catch(() => false);
    if (cloud !== ($('#captions-engine').value === 'groq')) return;
    $('#captions-help').textContent = cloud ? 'Dźwięk wybranego fragmentu zostanie wysłany do Groq. Klucz pozostaje w pamięci aplikacji.'
      : ready ? 'Model Whisper jest na tym komputerze.' : 'Pierwsze użycie pobierze model Whisper (148 MB). Dźwięk zostanie na komputerze.';
  }
  $('#captions-engine').onchange = generationHelp;
  async function openCaptions(expanded = false) {
    if (!cur || (remote && !remote.ready)) return;
    const c = cur, movie = remote;
    if (!captionDialog.open) {
      captionDialog.showModal();
      $('#captions-ai').open = expanded === true;
      $('#captions-engine').value = 'local';
      const playback = returnPlayback = { c, movie, resume: false };
      if (movie) {
        playback.paused = (async () => {
          const state = await window.kadr.movieAction(movie.id, 'status');
          if (state && !state.paused && returnPlayback === playback) {
            await window.kadr.movieAction(movie.id, 'pause');
            playback.resume = true;
          }
        })().catch(() => {});
      } else if (!video.paused) { video.pause(); playback.resume = true; }
    }
    captionStatus.textContent = '';
    $('#captions-size').value = S.subSize;
    $('#captions-bg').value = S.subBg;
    $('#captions-delay').value = c.subDelay || 0;
    $('#captions-save').hidden = !c.generated?.length;
    const canGenerate = movie || (c.info?.audio?.length && !/^https?:/i.test(c.item.path));
    $('#captions-help').hidden = $('#captions-generate').hidden = $('#captions-ai').hidden = !canGenerate;
    void generationHelp();
    captionAppearance();
    const revision = ++pickerRevision;
    const current = () => revision === pickerRevision && cur === c && captionDialog.open;
    try {
      const list = movie ? await window.kadr.movieAction(movie.id, 'caption-list') : { langs: [], tracks: c.subTracks.map((t, index) =>
        ({ label: t.label, lang: t.lang, index, active: index === c.subSel })) };
      if (!current() || !list) return;
      const active = list.tracks.find(t => t.active);
      $('#captions-active').textContent = active ? 'Aktywne napisy · ' + active.label : 'Napisy wyłączone';
      const groups = new Map();
      function group(code) {
        const label = language(code);
        if (!groups.has(label)) groups.set(label, { tracks: [], sources: [] });
        return groups.get(label);
      }
      for (const t of list.tracks) group(t.lang || guessLang(t.label)).tracks.push(t);
      for (const l of list.langs) group(l.code).sources.push(l);
      const labels = Array.from(groups.keys()).sort((a,b) => Number(b === 'polski') - Number(a === 'polski') || a.localeCompare(b, 'pl'));
      languages.replaceChildren(...labels.map(l => new Option(l, l)));
      if (active) languages.value = language(active.lang || guessLang(active.label));
      languages.disabled = !labels.length;
      let query = 0;
      async function populate() {
        const q = ++query, g = groups.get(languages.value);
        versions.replaceChildren(new Option(g ? 'Wczytywanie…' : 'Brak dostępnych napisów', ''));
        versions.disabled = true;
        if (!g) return;
        const choices = g.tracks.map(t => ({ ...t, native: true }));
        for (const source of g.sources) {
          const rows = await window.kadr.movieAction(movie.id, 'caption-versions', source.code);
          if (!current() || q !== query) return;
          for (const r of rows || []) {
            const key = JSON.stringify([source.code, r.index, r.label]);
            if (!choices.some(t => t.source === key)) choices.push({ ...r, lang: source.code, source: key });
          }
        }
        versions.replaceChildren(new Option(choices.length ? 'Wybierz wersję…' : 'Brak wersji w tym języku', ''));
        choices.forEach((t, i) => versions.add(new Option((i + 1) + '. ' + t.label + (t.active ? ' ✓' : ''), String(i), false, !!t.active)));
        versions.disabled = !choices.length;
        versions.onchange = async () => {
          const t = choices[versions.value];
          if (!t) return;
          languages.disabled = versions.disabled = true;
          try {
            if (!movie) await selectSub(t.index);
            else if (t.native) await window.kadr.movieAction(movie.id, 'caption-select', t.index);
            else {
              const result = await window.kadr.movieAction(movie.id, 'caption-apply', t);
              if (!current()) return;
              if (!result.native) {
                const cues = result.cues || K.parseSubtitles(result.body);
                if (!cues.length) throw Error('Ta wersja nie zawiera rozpoznanych napisów.');
                await window.kadr.movieAction(movie.id, 'caption-add', { ...t, cues });
              }
            }
            if (current()) await openCaptions();
          } catch (e) { if (current()) { captionStatus.textContent = captionError(e); languages.disabled = versions.disabled = false; } }
        };
      }
      languages.onchange = () => populate().catch(e => { if (current()) captionStatus.textContent = captionError(e); });
      await populate();
    } catch (e) { if (current()) captionStatus.textContent = captionError(e); }
  }
  $('#captions-off').onclick = async () => {
    if (remote) await window.kadr.movieAction(remote.id, 'caption-select', -1);
    else await selectSub(-1);
    await openCaptions();
  };
  async function importRemoteFile(file) {
    const movie = remote;
    if (!movie?.ready) return;
    try {
      const cues = K.parseSubtitles(await window.kadr.readText(file), { fps: 23.976 });
      if (movie !== remote) return;
      if (!cues.length) throw Error('Plik nie zawiera rozpoznanych napisów.');
      await window.kadr.movieAction(movie.id, 'caption-add', { label: baseName(file), cues });
      closeCaptions();
    } catch (e) {
      if (movie !== remote) return;
      if (!captionDialog.open) await openCaptions();
      captionStatus.textContent = captionError(e);
    }
  }
  $('#captions-file').onclick = async () => {
    const c = cur, file = await window.kadr.openSubtitle();
    if (!file || cur !== c) return;
    if (remote) await importRemoteFile(file);
    else { addExternalSub(file, true); closeCaptions(); }
  };
  window.kadr.onCaptionProgress(({ position, seconds, start, length, received, total }) => {
    if (!generating || !captionDialog.open) return;
    const progress = $('#captions-progress');
    progress.hidden = !total;
    if (total) {
      progress.max = total;
      progress.value = received;
      captionStatus.textContent = 'Pobieranie modelu · ' + Math.floor(received * 100 / total) + '%';
      return;
    }
    captionStatus.textContent = 'Generowanie napisów od ' + fmt(position) + ' do ' + fmt(position + seconds) + ' · koniec zakresu ' + fmt(start + length);
  });
  function captionBusy(busy) {
    generating = busy;
    $('#captions-form').disabled = busy;
    $('#captions-close').setAttribute('aria-label', busy ? 'Anuluj generowanie' : 'Zamknij napisy');
  }
  $('#captions-generate').onclick = async () => {
    if (!cur || generating) return;
    await returnPlayback?.paused;
    if (!cur || generating || !captionDialog.open) return;
    const key = $('#captions-key').value.trim();
    const method = $('#captions-engine').value;
    if (method === 'groq' && !key) { captionStatus.textContent = 'Wklej klucz z konta Groq.'; $('#captions-key').focus(); return; }
    const c = cur, session = captionSession, range = $('#captions-range').value;
    const start = range === 'all' ? 0 : playbackTime();
    const length = Math.min(playbackDuration() - start, range === 'all' ? Infinity : Number(range));
    if (!Number.isFinite(length) || length <= 0.15) { captionStatus.textContent = 'Wybierz fragment przed końcem filmu.'; return; }
    const resumeLocal = !remote && !video.paused;
    if (resumeLocal) video.pause();
    captionBusy(true);
    try {
      const { cues, warning } = await window.kadr.generateCaptions({ id: remote?.id, file: c.item.path, stream: engine.sel.audio?.index, start, length, engine: method, key: method === 'groq' ? key : undefined });
      if (cur !== c || session !== captionSession || !captionDialog.open) return;
      if (!cues.length) { captionStatus.textContent = 'W tym fragmencie nie rozpoznano mowy.'; return; }
      const label = 'Whisper · ' + fmt(start) + ' – ' + fmt(warning ? cues[cues.length - 1].end : start + length);
      if (remote) await window.kadr.movieAction(remote.id, 'caption-add', { label, cues });
      else {
        c.subTracks.push({ kind: 'generated', label, cues });
        await selectSub(c.subTracks.length - 1);
      }
      c.generated = cues;
      await openCaptions();
      captionStatus.textContent = warning || 'Włączono napisy. Liczba kwestii: ' + cues.length + '.';
    } catch (e) {
      if (cur === c && session === captionSession) captionStatus.textContent = captionError(e);
    } finally {
      captionBusy(false);
      $('#captions-progress').hidden = true;
      if (resumeLocal && cur === c) video.play().catch(() => {});
    }
  };
  $('#captions-save').onclick = async () => {
    if (!cur?.generated?.length) return;
    const text = K.exportSrt(cur.generated, cur.subDelay || 0);
    try { await window.kadr.saveCaptions(cur.item.title || 'Napisy', text); }
    catch (e) { captionStatus.textContent = captionError(e); }
  };

  function chaptersMenu() {
    const ch = (cur && cur.info && cur.info.chapters) || [];
    const t = video.currentTime;
    return ch.map((c, i) => radio(`${fmt(c.start)}  ${c.title || 'Rozdział ' + (i + 1)}`, t >= c.start && t < c.end, () => engine.seek(c.start, true)));
  }
  function mainMenu() {
    const has = !!cur;
    const vid = has && cur.info && cur.info.video.length > 0;
    const items = [
      mk('Otwórz pliki…', openFiles, { accelerator: 'Ctrl+O' }),
      mk('Otwórz folder…', openFolder, { accelerator: 'Ctrl+Shift+O' }),
      mk('Otwórz adres URL…', openUrl, { accelerator: 'Ctrl+U' }),
      mk('Katalog Kadr…', openCatalog, { accelerator: 'Ctrl+K' }),
      mk('Ostatnio otwierane', null, { submenu: ST.recent.length ? ST.recent.slice(0, 15).map(r => mk(r.title || baseName(r.path), () => openRecent(r))) : [mk('(pusto)', null, { enabled: false })] }),
      sep,
      mk(has && !playbackPaused() ? 'Pauza' : 'Odtwórz', togglePlay, { enabled: has, accelerator: 'Space' }),
      mk('Zatrzymaj', stopPlayback, { enabled: has }),
      mk('Poprzedni', () => playRelative(-1), { enabled: plIndex > 0 }),
      mk('Następny', () => playRelative(1), { enabled: plIndex >= 0 && plIndex < playlist.length - 1 }),
      sep,
    ];
    if (cur?.item.catalog) {
      items.push(mk('Napisy Kadr…', openCaptions, { enabled: !!remote?.ready }));
      items.splice(6, 0, mk('Wróć do katalogu', returnToCatalog, { accelerator: 'Esc' }));
      items.push(mk(S.muted ? 'Włącz dźwięk' : 'Wycisz', () => $('#b-mute').click(), { accelerator: 'M' }));
      items.push(check('Pełny ekran', app.classList.contains('fullscreen'), () => window.kadr.fullscreen(), 'F'));
      items.push(mk('Lista odtwarzania', toggleList, { accelerator: 'P' }));
      items.push(mk('Ustawienia…', () => openPanel('picture'), { accelerator: 'Ctrl+,' }));
      items.push(mk('O programie i sponsorzy', () => openPanel('about')));
      return items;
    }
    items.push(mk('Dźwięk', null, { submenu: audioMenu(), enabled: has }));
    items.push(mk('Napisy Kadr…', openCaptions, { enabled: has }));
    if (has && cur.info && cur.info.chapters.length) items.push(mk('Rozdziały', null, { submenu: chaptersMenu() }));
    items.push(mk('Prędkość', null, { submenu: speedMenu(), enabled: has }));
    items.push(mk('Obraz', null, { enabled: vid, submenu: [
      mk('Dopasowanie', null, { submenu: [['fit', 'Dopasuj'], ['fill', 'Wypełnij (przytnij)'], ['stretch', 'Rozciągnij'], ['native', 'Oryginalny rozmiar 1:1'], ['integer', 'Całkowita wielokrotność']].map(([v, l]) => radio(l, S.fit === v, () => setSetting('fit', v))) }),
      mk('Proporcje', null, { submenu: ['auto', '16:9', '4:3', '21:9', '2.35:1', '1.85:1', '1:1', '9:16'].map(v => radio(v === 'auto' ? 'Automatyczne' : v, S.aspect === v, () => setSetting('aspect', v))) }),
      mk('Obrót', null, { submenu: [[0, 'Brak'], [90, '90° w prawo'], [180, '180°'], [270, '90° w lewo']].map(([v, l]) => radio(l, S.rotate === v, () => setSetting('rotate', v))) }),
      check('Odbicie lustrzane', S.flipH, () => setSetting('flipH', !S.flipH)),
      check('Usuń czarne pasy (ten plik)', !!(cur && cur.crop), () => toggleCrop(), 'C'),
      mk('Resetuj powiększenie i przesunięcie', () => { setSetting('zoom', 1); if (cur) cur.pan = { x: 0, y: 0 }; dirty = true; }),
    ] }));
    items.push(mk('Skalowanie', null, { enabled: S.renderer === 'gl', submenu: [['lanczos', 'Lanczos-3 (najwyższa jakość)'], ['spline36', 'Spline36'], ['mitchell', 'Mitchell-Netravali'], ['catrom', 'Catmull-Rom'], ['bilinear', 'Dwuliniowe'], ['nearest', 'Najbliższy sąsiad']].map(([v, l]) => radio(l, S.scaler === v, () => setSetting('scaler', v))) }));
    items.push(check('Płynny ruch', S.smooth, () => { setSetting('smooth', !S.smooth); osd(S.smooth ? 'Płynny ruch włączony' : 'Płynny ruch wyłączony'); }, 'Ctrl+I'));
    items.push(sep);
    items.push(mk('Zrzut klatki', screenshot, { enabled: vid, accelerator: 'S' }));
    items.push(check('Zawsze na wierzchu', S.onTop, () => setSetting('onTop', !S.onTop), 'T'));
    items.push(check('Mini odtwarzacz', app.classList.contains('mini'), () => toggleMini(), 'Ctrl+M'));
    items.push(check('Pełny ekran', app.classList.contains('fullscreen'), () => window.kadr.fullscreen(), 'F'));
    items.push(check('Statystyki', app.classList.contains('stats'), () => toggleStats(), 'I'));
    items.push(sep);
    items.push(mk('Lista odtwarzania', toggleList, { accelerator: 'P' }));
    items.push(mk('Ustawienia…', () => openPanel('picture'), { accelerator: 'Ctrl+,' }));
    items.push(mk('O programie i sponsorzy', () => openPanel('about')));
    return items;
  }

  function trackLabel(s, i, word) {
    const t = s.tags || {};
    const lang = K.langName(t.language || t.LANGUAGE);
    const parts = [];
    if (t.title) parts.push(t.title);
    if (lang) parts.push(lang);
    if (s.codec_type === 'audio') {
      parts.push((s.codec_name || '').toUpperCase().replace('_', '-') + (s.channels ? ' ' + ({ 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' }[s.channels] || s.channels + ' kan.') : ''));
    } else if (s.codec_type === 'subtitle') {
      parts.push({ subrip: 'SRT', ass: 'ASS', ssa: 'SSA', mov_text: 'tekst', webvtt: 'VTT', hdmv_pgs_subtitle: 'PGS (obraz)', dvd_subtitle: 'DVD (obraz)', dvb_subtitle: 'DVB (obraz)' }[s.codec_name] || s.codec_name);
      if (s.disposition && s.disposition.forced) parts.push('wymuszone');
    }
    return `${word} ${i + 1}${parts.length ? ': ' + parts.join(' · ') : ''}`;
  }

  // ---------- subtitles ----------
  async function discoverSubs() {
    if (!cur || !cur.info) return;
    const c = cur;
    c.subTracks = c.info.subs.map((s, i) => ({ kind: 'embedded', stream: s, label: trackLabel(s, i, 'Napisy'), lang: ((s.tags && (s.tags.language || s.tags.LANGUAGE)) || '').toLowerCase() }));
    if (!/^https?:/i.test(c.item.path)) {
      const files = await window.kadr.findSubs(c.item.path).catch(() => []);
      if (c !== cur) return;
      const vbase = titleOf(c.item.path).toLowerCase();
      for (const f of files) {
        const n = baseName(f);
        const stem = n.replace(/\.[^.]+$/, '');
        const tag = stem.toLowerCase().startsWith(vbase) ? stem.slice(vbase.length).replace(/^[._\- ]+/, '') : stem;
        c.subTracks.push({ kind: 'file', path: f, label: `Plik: ${tag ? tag + ' · ' : ''}${ext(f).toUpperCase()}`, lang: guessLang(tag || n) });
      }
    }
    if (!S.subsAuto || !c.subTracks.length) return;
    const prefs = String(S.subLang || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
    const aLang = ((engine.sel.audio && engine.sel.audio.tags && engine.sel.audio.tags.language) || '').toLowerCase();
    const audioIsPreferred = prefs.length && aLang && (aLang === prefs[0] || K.langName(aLang) === K.langName(prefs[0]));
    const match = l => prefs.findIndex(p => l && (l === p || l.startsWith(p) || K.langName(l) === K.langName(p)));
    let best = -1, bestScore = -1;
    c.subTracks.forEach((t, i) => {
      const forced = t.stream && t.stream.disposition && t.stream.disposition.forced;
      let score = -1;
      const m = match(t.lang);
      if (t.kind === 'file') score = m >= 0 ? 100 - m : (t.lang ? 10 : 60);
      else if (m >= 0) score = 80 - m + (t.stream.disposition && t.stream.disposition.default ? 5 : 0);
      else if (t.stream.disposition && t.stream.disposition.default) score = 20;
      if (audioIsPreferred && !forced) score = -1;
      if (forced && audioIsPreferred) score = 90;
      if (t.stream && t.stream.bitmap && score > 0) score -= 30;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0 && bestScore > 0) selectSub(best, true);
  }
  function guessLang(s) {
    const l = s.toLowerCase();
    if (/(^|[._\- \[(])(pl|pol|polish|polski|napisy)([._\- \])]|$)/.test(l)) return 'pol';
    if (/(^|[._\- \[(])(en|eng|english)([._\- \])]|$)/.test(l)) return 'eng';
    return '';
  }
  async function selectSub(i, auto) {
    if (!cur) return;
    const c = cur;
    const prevBurn = !!engine.sel.burn;
    c.subSel = i;
    c.cues = null;
    subsView.clear();
    if (i < 0) {
      if (prevBurn) engine.setBurn(null);
      if (!auto) osd('Napisy wyłączone');
      return;
    }
    const t = c.subTracks[i];
    if (t.kind === 'generated') {
      if (prevBurn) engine.setBurn(null);
      c.cues = t.cues;
      subsView.set(t.cues);
      return;
    }
    const isAss = t.kind === 'embedded' ? ['ass', 'ssa'].includes(t.stream.codec_name) : ['ass', 'ssa'].includes(ext(t.path));
    if (t.kind === 'embedded' && (t.stream.bitmap || (isAss && S.burnAss))) {
      engine.setBurn(t.stream);
      osd(t.label, t.stream.bitmap ? 'napisy obrazkowe — wypalane w obraz (konwersja w locie)' : 'styl ASS — wypalany w obraz', 2600);
      return;
    }
    if (prevBurn) engine.setBurn(null);
    try {
      if (!auto) osd('Wczytywanie napisów…', t.label, 4000);
      const text = t.kind === 'embedded' ? await window.kadr.subEmbedded(c.item.path, t.stream.index) : await window.kadr.readText(t.path);
      if (c !== cur || c.subSel !== i) return;
      const cues = K.parseSubtitles(text, { fps: K.streamFps(engine.sel.video) || 23.976 });
      c.cues = cues;
      subsView.set(cues);
      osd(t.label, cues.length ? `${cues.length} kwestii` : 'plik nie zawiera rozpoznanych napisów', 1600);
    } catch (e) {
      if (c === cur) osd('Nie udało się wczytać napisów', String(e.message || e).slice(0, 120), 3000);
    }
  }
  function addExternalSub(file, select) {
    if (!cur) return;
    if (remote) { void importRemoteFile(file); return; }
    const i = cur.subTracks.findIndex(t => t.path === file);
    if (i >= 0) { if (select) selectSub(i); return; }
    cur.subTracks.push({ kind: 'file', path: file, label: `Plik: ${baseName(file)}`, lang: guessLang(baseName(file)) });
    if (select) selectSub(cur.subTracks.length - 1);
  }
  function subDelay(d) {
    if (!cur) return;
    cur.subDelay = Math.round(((cur.subDelay || 0) + d) * 10) / 10;
    subsView.key = '\u0000';
    captionAppearance();
    osd(`Opóźnienie napisów ${cur.subDelay > 0 ? '+' : ''}${cur.subDelay.toFixed(1)} s`);
  }
  function cycleSub() {
    if (!cur || !cur.subTracks.length) { osd('Brak napisów'); return; }
    const n = cur.subSel + 1 >= cur.subTracks.length ? -1 : cur.subSel + 1;
    selectSub(n);
  }
  function cycleAudio() {
    if (!cur || !cur.info || cur.info.audio.length < 2) { osd(cur && cur.info && cur.info.audio.length ? 'Tylko jedna ścieżka dźwiękowa' : 'Brak dźwięku'); return; }
    const list = cur.info.audio;
    const i = (list.indexOf(engine.sel.audio) + 1) % list.length;
    engine.setAudio(list[i]);
    osd('Dźwięk: ' + trackLabel(list[i], i, 'Ścieżka'));
  }

  // ---------- crop (black bars) ----------
  async function autoCrop(silent) {
    if (!cur || !cur.info || !cur.info.video.length || /^https?:/i.test(cur.item.path)) return;
    const c = cur, v = engine.sel.video;
    if (!silent) osd('Wykrywanie czarnych pasów…', '', 4000);
    const r = await window.kadr.cropdetect(c.item.path, c.info.duration).catch(() => null);
    if (c !== cur) return;
    const W = v.width, H = v.height;
    if (!r || !W || !H || (r.w >= W - 8 && r.h >= H - 8)) { if (!silent) osd('Brak czarnych pasów'); return; }
    c.crop = { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H };
    dirty = true;
    osd('Usunięto czarne pasy', `${W}×${H} → ${r.w}×${r.h}`);
  }
  function toggleCrop() {
    if (!cur) return;
    if (cur.crop) { cur.crop = null; dirty = true; osd('Pełny kadr'); } else autoCrop(false);
  }

  // ---------- screenshot ----------
  async function screenshot() {
    if (!cur || !video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    const t = fmt(video.currentTime).replace(/:/g, '-');
    try {
      const file = await window.kadr.saveShot({ dataUrl: c.toDataURL('image/png'), name: `${titleOf(cur.item.path)} ${t}` });
      osd('Zapisano zrzut klatki', file, 2600);
    } catch (e) { osd('Nie udało się zapisać zrzutu', e.message); }
  }

  // ---------- stats ----------
  function toggleStats() { app.classList.toggle('stats'); updateStats(); }
  function updateStats() {
    const el = $('#stats');
    if (!cur || !cur.info) { el.textContent = 'Brak pliku'; return; }
    const i = cur.info, v = engine.sel.video, a = engine.sel.audio;
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const L = [];
    const mb = n => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB';
    L.push(`<b>Plik</b>      ${esc(baseName(cur.item.path))}`);
    L.push(`<b>Kontener</b>  ${esc(i.containerLong || i.container)}${i.size ? ' · ' + mb(i.size) : ''}${i.bitrate ? ' · ' + (i.bitrate / 1e6).toFixed(2) + ' Mb/s' : ''}`);
    const modeName = { direct: 'bezpośrednio (plik)', copy: 'przepakowanie bez strat (ffmpeg → MP4)', encode: `konwersja w locie (${pickEncoder()}, ${{ max: 'najwyższa', balanced: 'zrównoważona', fast: 'wydajność' }[S.quality]})` }[engine.mode] || '—';
    L.push(`<b>Tryb</b>      ${modeName}${engine.reasons && engine.reasons.length ? ' — ' + esc(engine.reasons.join(', ')) : ''}`);
    if (v) {
      const hdr = K.isHDR(v) ? ' · HDR ' + (v.color_transfer === 'arib-std-b67' ? 'HLG' : 'PQ') : '';
      L.push(`<b>Obraz</b>     ${v.codec_name}${v.profile ? ' ' + v.profile : ''} · ${v.width}×${v.height} · ${(K.streamFps(v) || 0).toFixed(3)} kl/s · ${v.pix_fmt || ''}${v.color_space ? ' · ' + v.color_space : ''}${hdr}${K.isInterlaced(v) ? ' · z przeplotem' : ''}`);
      const dpr = (devicePixelRatio || 1) * (useGL() ? +S.renderScale : 1);
      const r = rect || {};
      const scalerName = { lanczos: 'Lanczos-3', spline36: 'Spline36', mitchell: 'Mitchell', catrom: 'Catmull-Rom', bilinear: 'dwuliniowe', nearest: 'najbliższy sąsiad' }[effScaler()];
      L.push(`<b>Ekran</b>     ${Math.round((r.w || 0) * dpr)}×${Math.round((r.h || 0) * dpr)} px · ${useGL() ? 'WebGL2 · ' + scalerName + (effLinear() && gl.float ? ' · liniowo 16-bit' : '') + (S.sharpen ? ' · RCAS ' + Math.round(S.sharpen * 100) + '%' : '') + (S.deband ? ' · deband' : '') + (effSmooth() ? ' · płynny ruch' : '') + (perfLevel ? ` · odciążone (${perfLevel})` : '') : 'natywny (Chromium)'}`);
      L.push(`<b>Klatki</b>    ${q ? `wyświetlone ${q.totalVideoFrames - q.droppedVideoFrames}, utracone ${q.droppedVideoFrames}` : ''} · renderowanie ${useGL() ? drawFps.toFixed(1) : '—'} kl/s · ekran ~${Math.round(1 / vsync)} Hz`);
    }
    if (a) L.push(`<b>Dźwięk</b>    ${a.codec_name}${a.profile ? ' ' + a.profile : ''} · ${a.channels || '?'} kan. · ${a.sample_rate ? (a.sample_rate / 1000) + ' kHz' : ''}${a.bit_rate ? ' · ' + Math.round(a.bit_rate / 1000) + ' kb/s' : ''}${engine.mode !== 'direct' && !engine.audioCopyOK(a) ? ' → AAC' : ''}`);
    if (engine.mode !== 'direct') L.push(`<b>Bufor</b>     ${engine.ahead().toFixed(1)} s naprzód`);
    if (gl && gl.gpu) L.push(`<b>GPU</b>       ${esc(gl.gpu)}`);
    el.innerHTML = L.join('\n');
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- opening files ----------
  async function openFiles() { const f = await window.kadr.openFiles(); if (f.length) openPaths(f); }
  async function openFolder() { const f = await window.kadr.openFolder(); if (f.length) openPaths(f); }
  function openUrl() {
    const m = $('#modal'), inp = $('#url-input');
    m.classList.add('open');
    window.kadr.clipboardText().then(t => { if (!inp.value && /^https?:\/\//i.test((t || '').trim())) inp.value = t.trim(); inp.select(); });
    setTimeout(() => inp.focus(), 30);
  }
  $('#url-input').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') $('[data-act=url-ok]').click();
    if (e.key === 'Escape') $('#modal').classList.remove('open');
  });

  async function openPaths(paths, opts = {}) {
    let list = await window.kadr.expand(paths);
    if (!list.length) { osd('Brak plików do odtworzenia'); return; }
    let start = 0;
    if (!opts.append && list.length === 1 && paths.length === 1 && S.autoFolder && !/^https?:/i.test(list[0])) {
      const one = list[0];
      const kindAudio = AUDIO_EXT.includes(ext(one));
      const sibs = (await window.kadr.expand([dirName(one)]).catch(() => [])).filter(p => dirName(p) === dirName(one) && AUDIO_EXT.includes(ext(p)) === kindAudio);
      if (sibs.length > 1 && sibs.length < 500) { start = Math.max(0, sibs.findIndex(p => p.toLowerCase() === one.toLowerCase())); list = sibs; }
    }
    const items = list.map(p => ({ path: p, title: titleOf(p) }));
    if (opts.append && playlist.length) {
      playlist.push(...items);
      osd(`Dodano do listy: ${items.length}`);
      renderPlaylist();
      return;
    }
    playlist = items;
    renderPlaylist();
    playIndex(start);
  }

  function openCatalogItem(item) {
    playlist = [item];
    playIndex(0);
  }

  function openRecent(item) {
    if (item.catalog) openCatalogItem({ path: item.path, title: item.title, catalog: true });
    else openPaths([item.path]);
  }

  function playIndex(i, opts = {}) {
    if (i < 0 || i >= playlist.length) return;
    plIndex = i;
    playItem(playlist[i], opts);
    renderPlaylist();
  }
  function playRelative(d) {
    if (!playlist.length) return;
    let i;
    if (S.shuffle && playlist.length > 2 && d > 0) { do { i = Math.floor(Math.random() * playlist.length); } while (i === plIndex); }
    else i = plIndex + d;
    if (i >= playlist.length) { if (S.repeat === 'all') i = 0; else return; }
    if (i < 0) { if (S.repeat === 'all') i = playlist.length - 1; else { engine.seek(0); return; } }
    playIndex(i);
  }
  function stopPlayback() {
    closeCaptions();
    saveResume();
    closeRemote();
    engine.stop();
    cur = null;
    subsView.clear();
    clearThumbs();
    app.classList.add('empty');
    app.classList.remove('audio-only', 'error', 'waiting', 'catalog-selection');
    $('#title-text').textContent = '';
    window.kadr.title('Kadr');
    window.kadr.powerBlock(false);
    renderRecent();
  }

  function returnToCatalog() {
    if (!cur?.item.catalog) return;
    stopPlayback();
    closeDrawers();
    openCatalog();
  }

  function resumeKey(p) { return p.toLowerCase(); }
  function saveResume() {
    if (!cur || (!cur.info && !remote?.ready) || !S.resume) return;
    const d = playbackDuration(), t = playbackTime();
    const k = resumeKey(cur.item.path);
    if (d > 60 && t > 10 && t < d - 20) ST.resume[k] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
    else if (t >= d - 20 && d) delete ST.resume[k];
    const keys = Object.keys(ST.resume);
    if (keys.length > 400) keys.sort((a, b) => ST.resume[a].at - ST.resume[b].at).slice(0, keys.length - 400).forEach(k2 => delete ST.resume[k2]);
    const r = ST.recent.find(x => x.path === cur.item.path);
    if (r) { r.t = Math.round(t); r.d = Math.round(d); }
    saveState();
  }

  function playItem(item, opts = {}) {
    closeCaptions();
    saveResume();
    closeRemote();
    clearThumbs();
    const c = { item, info: null, crop: null, pan: { x: 0, y: 0 }, subTracks: [], subSel: -1, subDelay: 0, cues: null, firstFrame: true };
    cur = c;
    if (!item.catalog && !renderFrame) renderFrame = requestAnimationFrame(loop);
    app.classList.toggle('catalog-selection', !!item.catalog);
    subsView.clear();
    app.classList.remove('empty', 'error', 'audio-only');
    app.classList.add('waiting');
    $('#title-text').textContent = item.title;
    window.kadr.title(`${item.title} — Kadr`);
    let start = opts.start || 0;
    const res = ST.resume[resumeKey(item.path)];
    if (!opts.start && S.resume && res && res.t > 10) { start = res.t; c.resumed = true; }
    ST.recent = [{ path: item.path, title: item.title, catalog: item.catalog, at: Date.now(), t: start, d: res ? res.d : 0 }, ...ST.recent.filter(r => r.path !== item.path)].slice(0, 30);
    saveState();
    if (item.catalog) {
      engine.stop();
      startCatalogMovie(item, start);
      return;
    }
    sound.ensure(); sound.resume();
    gl && (gl.texW = 0);
    engine.load(item, { start });
    if (c.resumed) osd(`Wznowiono od ${fmt(start)}`, 'Home — od początku', 3000);
    showUI();
  }

  // ---------- engine events ----------
  engine.on('info', info => {
    if (!cur) return;
    cur.info = info;
    const audioOnly = !info.video.length;
    app.classList.toggle('audio-only', audioOnly);
    if (audioOnly) {
      const img = $('#cover-img');
      img.removeAttribute('src');
      if (info.cover && !/^https?:/i.test(cur.item.path)) img.src = engine.url('/cover', { p: cur.item.path });
      const tg = info.tags || {};
      const meta = $('#cover-meta');
      meta.textContent = '';
      const b = document.createElement('b'); b.textContent = tg.title || tg.TITLE || cur.item.title;
      const s = document.createElement('span'); s.textContent = [tg.artist || tg.ARTIST, tg.album || tg.ALBUM].filter(Boolean).join(' — ');
      meta.append(b, s);
    }
    const chEl = seekEl.querySelector('.chapters');
    chEl.textContent = '';
    if (info.duration) for (const ch of info.chapters) { if (ch.start <= 0.5) continue; const i = document.createElement('i'); i.style.left = (ch.start / info.duration * 100) + '%'; chEl.appendChild(i); }
    const r = ST.recent.find(x => x.path === cur.item.path);
    if (r) { r.d = Math.round(info.duration); saveState(); }
    discoverSubs();
    if (S.autoCrop && !audioOnly) autoCrop(true);
    mediaSession();
    applySound();            // smooth motion delays the sound by one frame of this file
  });
  engine.on('mode', (mode, reasons) => {
    const b = $('#mode-badge');
    b.textContent = { direct: 'BEZPOŚREDNIO', copy: 'REMUX BEZ STRAT', encode: 'KONWERSJA · ' + pickEncoder().replace('h264_', '').replace('lib', '').toUpperCase() }[mode] || '';
    b.classList.toggle('on', !!mode);
    if (mode === 'encode' && reasons && reasons.length) osd('Konwersja w locie', reasons.join(', '), 2200);
    if (app.classList.contains('stats')) updateStats();
  });
  engine.on('error', (msg, o) => {
    $('#error-text').textContent = msg;
    $('[data-act=force-encode]').style.display = o && o.retry === false ? 'none' : '';
    app.classList.add('error');
    app.classList.remove('waiting');
  });
  engine.on('end-of-stream', () => { if (!video.ended && !video.paused) onEnded(); });
  engine.on('page-search', () => osd('To strona WWW — szukam na niej filmu…', '', 8000));
  engine.on('page-found', ({ url, title }) => {
    if (!cur) return;
    if (title) { cur.item.title = title; $('#title-text').textContent = title; window.kadr.title(`${title} — Kadr`); }
    const r = ST.recent.find(x => x.path === cur.item.path); if (r && title) { r.title = title; saveState(); }
    osd('Znaleziono film na stronie', baseName(url), 2500);
  });
  engine.on('downscale', h => osd(`Konwersja nie nadąża — obniżam do ${h}p`, 'zmienisz to w Ustawienia ▸ Jakość', 3500));
  function onEnded() {
    if (!cur) return;
    if (cur.endedAt && performance.now() - cur.endedAt < 1500) return;
    cur.endedAt = performance.now();
    delete ST.resume[resumeKey(cur.item.path)];
    const r = ST.recent.find(x => x.path === cur.item.path); if (r) r.t = 0;
    saveState();
    if (remote) {
      if (S.repeat === 'one' || (S.repeat === 'all' && playlist.length === 1)) {
        controlMovie('seek', 0).then(() => { if (remote && playbackPaused()) controlMovie('toggle'); });
      } else if (S.autoNext && (plIndex < playlist.length - 1 || S.repeat === 'all')) playRelative(1);
      return;
    }
    if (S.repeat === 'one') { engine.seek(0, true); engine.play(); return; }
    if (S.autoNext && (plIndex < playlist.length - 1 || (S.repeat === 'all' && playlist.length > 1) || (S.shuffle && playlist.length > 2))) { playRelative(1); return; }
    if (S.repeat === 'all' && playlist.length === 1) { engine.seek(0, true); engine.play(); return; }
    showUI();
  }

  // ---------- video events ----------
  video.addEventListener('play', () => { setPlayIcon(); powerSync(); showUI(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  video.addEventListener('pause', () => { setPlayIcon(); powerSync(); showUI(); saveResume(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  video.addEventListener('ratechange', setPlayIcon);
  video.addEventListener('waiting', () => app.classList.add('waiting'));
  video.addEventListener('seeking', () => { if (video.readyState < 3) app.classList.add('waiting'); });
  for (const ev of ['playing', 'canplay', 'seeked', 'loadeddata']) video.addEventListener(ev, () => { if (video.readyState >= 3 || ev === 'playing') app.classList.remove('waiting'); dirty = true; });
  video.addEventListener('ended', onEnded);
  video.addEventListener('resize', () => { dirty = true; if (cur && cur.firstFrame && video.videoWidth) { cur.firstFrame = false; if (S.fitWindow) window.kadr.fitVideo({ w: video.videoWidth, h: video.videoHeight }); } });
  video.addEventListener('loadedmetadata', () => { dirty = true; video.preservesPitch = S.preservesPitch; if (video.playbackRate !== video.defaultPlaybackRate) video.playbackRate = video.defaultPlaybackRate; });
  let powered = false;
  function powerSync() {
    const on = !!cur && !video.paused && !!(cur.info && cur.info.video.length);
    if (on !== powered) { powered = on; window.kadr.powerBlock(on); }
  }

  function mediaSession() {
    if (!('mediaSession' in navigator) || !cur) return;
    const tg = (cur.info && cur.info.tags) || {};
    navigator.mediaSession.metadata = new MediaMetadata({ title: tg.title || cur.item.title, artist: tg.artist || tg.ARTIST || '', album: tg.album || '' });
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => { if (video.paused) togglePlay(); });
    ms.setActionHandler('pause', () => { if (!video.paused) togglePlay(); });
    ms.setActionHandler('previoustrack', () => playRelative(-1));
    ms.setActionHandler('nexttrack', () => playRelative(1));
    ms.setActionHandler('seekbackward', () => seekBy(-10));
    ms.setActionHandler('seekforward', () => seekBy(10));
    try { ms.setActionHandler('stop', stopPlayback); } catch {}
  }

  // ---------- settings ----------
  const PIPELINE = ['playMode', 'encoder', 'quality', 'maxHeight', 'deint', 'tonemap', 'interp', 'interpFps', 'stereo'];
  const SOUND = ['eqOn', 'eq', 'preamp', 'normalize', 'dialog', 'mono', 'audioDelay'];
  const SUBSTYLE = ['subSize', 'subColor', 'subOutline', 'subBg', 'subPos', 'subFont', 'subBold', 'subMargins'];
  let replanTimer;
  function setSetting(key, val, live) {
    S[key] = val;
    if (profileKeys.includes(key)) { S.localProfileId = 'custom'; S.customQuality = snapshotQuality(); }
    if (['scaler', 'linear', 'smooth', 'renderer', 'renderScale'].includes(key)) perfLevel = 0;   // the user decides again
    if (!live) saveSettings(); else saveSettings();
    if (key === 'renderer') setupRenderer();
    if (PIPELINE.includes(key)) { clearTimeout(replanTimer); replanTimer = setTimeout(() => engine.replan(), 350); }
    if (SOUND.includes(key)) applySound();
    if (key === 'eqPreset' && K.EQ_PRESETS[val]) { S.eq = K.EQ_PRESETS[val].g.slice(); applySound(); }
    if (SUBSTYLE.includes(key)) { applySubStyle(); captionAppearance(); }
    if (key === 'smooth') applySound();
    if (key === 'sink') sound.setSink(val);
    if (key === 'volumeMax') { S.volume = Math.min(S.volume, +val); applyVolume(); }
    if (key === 'preservesPitch') video.preservesPitch = val;
    if (key === 'onTop') window.kadr.onTop(val);
    if (key === 'hwdec') osd('Zmiana zadziała po ponownym uruchomieniu', '', 2500);
    if (key === 'burnAss' && cur && cur.subSel >= 0) selectSub(cur.subSel, true);
    if (key === 'thumbs') clearThumbs();
    dirty = true;
  }
  function applySound() {
    const fps = K.streamFps(engine.sel && engine.sel.video) || 24;
    sound.set({ eqOn: S.eqOn, eq: S.eq, preamp: S.preamp, normalize: S.normalize, dialog: S.dialog, mono: S.mono, delayMs: S.audioDelay,
      extraDelay: effSmooth() && S.renderer === 'gl' && cur && cur.info && cur.info.video.length ? 1 / fps : 0 });
  }

  let sinkList = [];
  async function refreshSinks() { sinkList = await sound.devices(); }
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', refreshSinks);

  const panel = $('#panel');
  let panelTab = 'picture';
  function openPanel(tab) {
    panelTab = tab || panelTab;
    $('#playlist').classList.remove('open');
    panel.classList.add('open');
    renderPanel();
    showUI();
  }
  function togglePanel() { if (panel.classList.contains('open')) panel.classList.remove('open'); else openPanel(); }
  function closeDrawers() { panel.classList.remove('open'); $('#playlist').classList.remove('open'); }
  async function renderPanel() {
    if (panelTab === 'audio') await refreshSinks();
    const tabs = $('#panel-tabs');
    tabs.textContent = '';
    for (const t of K.SCHEMA) {
      const b = document.createElement('button');
      b.textContent = t.title;
      b.className = t.id === panelTab ? 'active' : '';
      b.onclick = () => { panelTab = t.id; renderPanel(); };
      tabs.appendChild(b);
    }
    K.buildPanel($('#panel-body'), panelTab, {
      settings: S,
      set: (k, v, live) => setSetting(k, v, live),
      action: name => {
        if (name === 'reset-colors') for (const k of ['bright', 'contr', 'sat', 'gamma', 'hue']) setSetting(k, K.DEFAULTS[k]);
      },
      options: name => {
        if (name === 'encoders') {
          const names = { h264_nvenc: 'NVIDIA NVENC (sprzętowy)', h264_qsv: 'Intel Quick Sync (sprzętowy)', h264_amf: 'AMD AMF (sprzętowy)', libx264: 'x264 (procesor)' };
          return [['auto', `Automatycznie${encList ? ' — ' + (names[encList[0]] || encList[0]) : ' (wykrywanie…)'}`], ...(encList || ['libx264']).map(e => [e, names[e] || e])];
        }
        if (name === 'sinks') return (sinkList.length ? sinkList : [{ id: 'default', label: 'Domyślne urządzenie' }]).map(d => [d.id, d.label]);
        if (name === 'eqPresets') return [...Object.entries(K.EQ_PRESETS).map(([k, p]) => [k, p.name]), ['custom', 'Własne']];
        return [];
      },
      info: (id, el) => {
        if (id === 'mode-info') {
          if (!cur || !cur.info) { el.innerHTML = 'Otwórz plik, aby zobaczyć, jak jest odtwarzany.'; return; }
          const m = { direct: '<b>Bezpośrednio</b> — plik odtwarzany bez pośredników.', copy: '<b>Przepakowanie bez strat</b> — ffmpeg zmienia tylko pojemnik, obraz jest nietknięty.', encode: `<b>Konwersja w locie</b> koderem <b>${esc(pickEncoder())}</b>.` }[engine.mode] || '';
          el.innerHTML = m + (engine.reasons && engine.reasons.length ? `<br>Powód: ${esc(engine.reasons.join(', '))}.` : '');
        }
      },
      about: body => renderAbout(body),
    });
  }
  const notice = $('#update-notice');
  let updateState = { phase: 'idle', message: '' }, laterVersion = '';
  function showUpdate(state) {
    updateState = state;
    const about = $('#update-status');
    if (about) about.textContent = state.message;
    const offered = ['available', 'ready', 'downloading'].includes(state.phase);
    notice.hidden = !offered || state.version === laterVersion;
    $('#update-message').textContent = state.message + (state.version ? ' · ' + state.version : '');
    $('#update-act').hidden = state.phase === 'downloading';
    $('#update-act').textContent = state.phase === 'ready' ? 'Uruchom ponownie i zainstaluj' : 'Pobierz';
    refreshMovieView();
  }
  window.kadr.onUpdate(showUpdate);
  $('#update-later').onclick = () => { laterVersion = updateState.version; showUpdate(updateState); };
  $('#update-act').onclick = async () => {
    if (updateState.phase === 'ready') {
      saveResume();
      await Promise.all([window.kadr.saveState(ST), window.kadr.saveSettings(S)]);
      await window.kadr.installUpdate();
    } else if (updateState.phase === 'available') await window.kadr.downloadUpdate();
  };
  new ResizeObserver(refreshMovieView).observe(notice);
  void window.kadr.checkUpdate().then(showUpdate);

  // ---------- licence: asked once per computer (first start), kept in state.json ----------
  const LICENSE_SHA256 = '1785cfc3bc6ac7738e8b38cdccd1af12563c2b9070e07af336a1bf8c0f772b6a';
  async function licenseOk(code) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(code).trim().toLowerCase()));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') === LICENSE_SHA256;
  }
  function requireLicense() {
    if (ST.license === LICENSE_SHA256) return Promise.resolve();
    const dlg = $('#license-dialog'), input = $('#license-code'), err = $('#license-error');
    return new Promise(resolve => {
      dlg.addEventListener('cancel', e => e.preventDefault());     // Escape doesn't skip it
      $('#license-form').onsubmit = async e => {
        e.preventDefault();
        if (!await licenseOk(input.value)) { err.hidden = false; input.select(); return; }
        ST.license = LICENSE_SHA256;
        await window.kadr.saveState(ST);
        dlg.close();
        resolve();
      };
      input.oninput = () => { err.hidden = true; };
      dlg.showModal();
      input.focus();
    });
  }

  function renderAbout(body) {
    const d = document.createElement('div');
    d.innerHTML = `
      <div class="about-head"><img src="img/logo.svg" alt=""><div><h3>Kadr</h3><span>wersja ${esc(cfg.version)}</span></div></div>
      <div class="info-box">Odtwarzacz wideo na Windows: każdy format dzięki <b>FFmpeg</b>, skalowanie Lanczos/Spline z poprawnym pomniejszaniem, wyostrzanie AMD RCAS, usuwanie pasm, płynny ruch, korektor dźwięku i napisy w polskich formatach.</div>
      <div class="sec">Aktualizacje</div>
      <button id="update-check" class="btn">Sprawdź aktualizacje</button>
      <p id="update-status" role="status"></p>
      <div class="sec">Sponsorzy</div>
      <a class="sp-card pz" data-sp="pz"><img src="img/prozlecenie.png" alt=""><div><b>ProZlecenie.pl</b><small>Opisz robotę budowlaną lub remontową — fachowcy z Twojej okolicy sami zgłoszą się z ceną. Za darmo.</small></div><span class="go">Odwiedź →</span></a>
      <a class="sp-card cs" data-sp="cs"><span class="cs-logo"><img src="img/cyberscope.svg" alt=""></span><div><b>CyberScope.pl</b><small>Portal o cyberbezpieczeństwie: aktualności, analizy i poradniki — jak rozpoznać oszustwo i chronić swoje dane.</small></div><span class="go">Odwiedź →</span></a>
      <div class="sec">Skróty klawiszowe</div>
      <div class="keys">
        <kbd>Spacja</kbd><span>odtwórz / pauza</span>
        <kbd>← →</kbd><span>przewiń o ${S.seekStep} s (Shift: 1 s, Ctrl: 60 s)</span>
        <kbd>↑ ↓</kbd><span>głośność</span>
        <kbd>J / L</kbd><span>10 s do tyłu / naprzód</span>
        <kbd>, / .</kbd><span>poprzednia / następna klatka</span>
        <kbd>[ / ]</kbd><span>wolniej / szybciej, Backspace — normalnie</span>
        <kbd>F</kbd><span>pełny ekran (lub dwuklik)</span>
        <kbd>M</kbd><span>wycisz</span>
        <kbd>V / B</kbd><span>następne napisy / ścieżka dźwiękowa</span>
        <kbd>Z / X</kbd><span>napisy wcześniej / później</span>
        <kbd>S</kbd><span>zrzut klatki (Obrazy\\Kadr)</span>
        <kbd>C</kbd><span>usuń czarne pasy</span>
        <kbd>A</kbd><span>przełącz proporcje</span>
        <kbd>R</kbd><span>obróć o 90°</span>
        <kbd>D</kbd><span>usuwanie pasm (deband)</span>
        <kbd>I</kbd><span>statystyki</span>
        <kbd>Ctrl+I</kbd><span>płynny ruch</span>
        <kbd>N / Shift+N</kbd><span>następny / poprzedni plik</span>
        <kbd>PgUp / PgDn</kbd><span>rozdziały (albo pliki z listy)</span>
        <kbd>0–9</kbd><span>skok do 0–90%</span>
        <kbd>Ctrl+kółko</kbd><span>powiększenie, Ctrl+strzałki — przesuwanie</span>
        <kbd>T</kbd><span>zawsze na wierzchu</span>
        <kbd>Ctrl+M</kbd><span>mini odtwarzacz</span>
        <kbd>P</kbd><span>lista odtwarzania</span>
        <kbd>Ctrl+O / Ctrl+U</kbd><span>otwórz plik / adres</span>
      </div>
      <div class="sec">Technika</div>
      <div class="info-box" id="tech-info">…</div>
      <div class="info-box">Kadr zawiera FFmpeg (licencja GPL v3, ffmpeg.org) oraz ikony Lucide (ISC). Inter — SIL Open Font License.</div>`;
    body.appendChild(d);
    $('#update-status').textContent = updateState.message;
    $('#update-check').onclick = async () => { laterVersion = ''; showUpdate(await window.kadr.checkUpdate()); };
    d.querySelectorAll('[data-sp]').forEach(a => { a.onclick = e => { e.preventDefault(); window.kadr.external(SPONSORS[a.dataset.sp]); }; });
    (async () => {
      const ver = await window.kadr.ffmpegVersion().catch(() => '?');
      const sup = engine.sup;
      const yes = b => (b ? 'tak' : 'nie');
      const t = d.querySelector('#tech-info');
      if (!t) return;
      t.innerHTML = `FFmpeg <b>${esc(ver || '?')}</b> · koder konwersji: <b>${esc(pickEncoder())}</b><br>` +
        `Dekodowanie w Chromium: H.264 ${yes(sup.h264)}, HEVC ${yes(sup.hevc)} (10-bit ${yes(sup.hevc10)}), VP9 ${yes(sup.vp9)}, AV1 ${yes(sup.av1)}<br>` +
        `Renderer: ${useGL() ? 'WebGL2' + (gl.float ? ' (16-bit)' : '') + ' — ' + esc(gl.gpu || '') : 'natywny'}`;
    })();
  }

  // ---------- playlist drawer ----------
  function toggleList() {
    const pl = $('#playlist');
    if (pl.classList.contains('open')) pl.classList.remove('open');
    else { panel.classList.remove('open'); pl.classList.add('open'); renderPlaylist(); showUI(); }
  }
  let dragFrom = -1;
  function renderPlaylist() {
    $('#pl-shuffle').classList.toggle('on', !!S.shuffle);
    const rep = $('#pl-repeat');
    rep.classList.toggle('on', S.repeat !== 'off');
    rep.innerHTML = icon(S.repeat === 'one' ? 'repeat-1' : 'repeat');
    rep.dataset.tip = { off: 'Powtarzanie: wyłączone', all: 'Powtarzanie: cała lista', one: 'Powtarzanie: jeden plik' }[S.repeat];
    $('#b-prev').disabled = plIndex <= 0 && S.repeat !== 'all';
    $('#b-next').disabled = !(plIndex < playlist.length - 1 || S.repeat === 'all' || S.shuffle) || !playlist.length;
    if (!$('#playlist').classList.contains('open')) return;
    const ol = $('#pl-items');
    ol.textContent = '';
    $('#pl-count').textContent = playlist.length ? `(${playlist.length})` : '';
    if (!playlist.length) { const e = document.createElement('div'); e.className = 'empty-list'; e.textContent = 'Lista jest pusta. Przeciągnij tu pliki albo użyj przycisków powyżej.'; ol.appendChild(e); return; }
    playlist.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = i === plIndex ? 'cur' : '';
      li.draggable = true;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = i + 1;
      const nm = document.createElement('div'); nm.className = 'nm';
      const b = document.createElement('b'); b.textContent = it.title;
      const s = document.createElement('span'); s.textContent = /^https?:/i.test(it.path) ? it.path : dirName(it.path);
      nm.append(b, s);
      const rm = document.createElement('button'); rm.className = 'rm'; rm.innerHTML = icon('x'); rm.dataset.tip = 'Usuń z listy';
      rm.onclick = e => { e.stopPropagation(); playlist.splice(i, 1); if (i < plIndex) plIndex--; else if (i === plIndex) plIndex = -1; renderPlaylist(); };
      li.append(n, nm, rm);
      li.ondblclick = () => playIndex(i);
      li.onclick = () => { if (i !== plIndex) playIndex(i); };
      li.ondragstart = e => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; };
      li.ondragover = e => { if (dragFrom >= 0) { e.preventDefault(); li.classList.add('drag-over'); } };
      li.ondragleave = () => li.classList.remove('drag-over');
      li.ondrop = e => {
        if (dragFrom < 0) return;
        e.preventDefault(); e.stopPropagation();
        const [moved] = playlist.splice(dragFrom, 1);
        const to = dragFrom < i ? i - 1 : i;
        playlist.splice(to, 0, moved);
        if (plIndex === dragFrom) plIndex = to; else if (dragFrom < plIndex && to >= plIndex) plIndex--; else if (dragFrom > plIndex && to <= plIndex) plIndex++;
        dragFrom = -1; renderPlaylist();
      };
      li.ondragend = () => { dragFrom = -1; };
      ol.appendChild(li);
    });
  }

  // ---------- welcome / recent ----------
  function renderRecent() {
    const box = $('#recent');
    box.textContent = '';
    const list = ST.recent.slice(0, 6);
    if (!list.length) return;
    const h = document.createElement('h2'); h.textContent = 'Ostatnio odtwarzane';
    const clr = document.createElement('button'); clr.textContent = 'Wyczyść';
    clr.onclick = () => { ST.recent = []; saveState(); renderRecent(); };
    h.appendChild(clr);
    box.appendChild(h);
    for (const r of list) {
      const el = document.createElement('div'); el.className = 'rec';
      const isA = AUDIO_EXT.includes(ext(r.path));
      el.innerHTML = icon(/^https?:/i.test(r.path) ? 'link' : isA ? 'music' : 'film');
      const meta = document.createElement('div'); meta.className = 'meta';
      const b = document.createElement('b'); b.textContent = r.title || baseName(r.path);
      const s = document.createElement('span'); s.textContent = r.catalog ? 'Katalog Kadr' : /^https?:/i.test(r.path) ? r.path : dirName(r.path);
      meta.append(b, s);
      el.appendChild(meta);
      const res = ST.resume[resumeKey(r.path)];
      if (res && res.d) { const pg = document.createElement('div'); pg.className = 'prog'; const i = document.createElement('i'); i.style.width = clamp(res.t / res.d * 100, 2, 100) + '%'; pg.appendChild(i); el.appendChild(pg); }
      const w = document.createElement('span'); w.className = 'when'; w.textContent = ago(r.at);
      el.appendChild(w);
      el.onclick = () => openRecent(r);
      box.appendChild(el);
    }
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'przed chwilą';
    if (s < 3600) return Math.floor(s / 60) + ' min temu';
    if (s < 86400) return Math.floor(s / 3600) + ' godz. temu';
    if (s < 172800) return 'wczoraj';
    return new Date(t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
  }

  // ---------- generic buttons ----------
  document.addEventListener('click', async e => {
    const a = e.target.closest('[data-act], [data-href]');
    if (!a) return;
    if (a.dataset.href) { e.preventDefault(); window.kadr.external(a.dataset.href); return; }
    switch (a.dataset.act) {
      case 'open-files': return openFiles();
      case 'open-folder': return openFolder();
      case 'open-url': return openUrl();
      case 'open-catalog': return openCatalog();
      case 'open-popular': return openCatalog(true);
      case 'url-cancel': return $('#modal').classList.remove('open');
      case 'url-ok': {
        const u = $('#url-input').value.trim();
        if (!u) return;
        $('#modal').classList.remove('open');
        return openPaths([u]);
      }
      case 'close-panel': return panel.classList.remove('open');
      case 'close-list': return $('#playlist').classList.remove('open');
      case 'pl-add': { const f = await window.kadr.openFiles(); if (f.length) openPaths(f, { append: true }); return; }
      case 'pl-folder': { const f = await window.kadr.openFolder(); if (f.length) openPaths(f, { append: true }); return; }
      case 'pl-shuffle': S.shuffle = !S.shuffle; saveSettings(); osd(S.shuffle ? 'Odtwarzanie losowe' : 'Odtwarzanie po kolei'); return renderPlaylist();
      case 'pl-repeat': S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat]; saveSettings(); osd({ off: 'Powtarzanie wyłączone', all: 'Powtarzanie listy', one: 'Powtarzanie jednego pliku' }[S.repeat]); return renderPlaylist();
      case 'pl-save': {
        if (!playlist.length) return;
        const f = await window.kadr.savePlaylist('#EXTM3U\r\n' + playlist.map(p => `#EXTINF:-1,${p.title}\r\n${p.path}`).join('\r\n') + '\r\n');
        if (f) osd('Zapisano listę', f);
        return;
      }
      case 'pl-clear': playlist = playlist.filter((p, i) => i === plIndex); plIndex = playlist.length ? 0 : -1; return renderPlaylist();
      case 'force-encode':
        app.classList.remove('error');
        if (cur && cur.info) { engine.failedModes = new Set(); engine.ms = null; engine.sb = null; engine.start(video.currentTime || 0, 'encode'); }
        return;
      case 'dismiss-error': app.classList.remove('error'); return;
    }
  });

  // ---------- keyboard ----------
  document.addEventListener('keydown', e => {
    if (nativeMenuOpen || document.querySelector('dialog[open]') || e.isComposing) return;
    if (e.key !== 'Escape' && (document.querySelector('.drawer.open, .modal.open') || e.target.closest('input, select, textarea, [contenteditable="true"]'))) return;
    if (e.repeat && [' ', 'k', 'm', 'f', 'v'].includes(e.key.toLowerCase())) { e.preventDefault(); return; }
    const k = e.key, ctrl = e.ctrlKey, shift = e.shiftKey;
    let handled = true;
    showUI();
    if (ctrl && (k === 'o' || k === 'O')) { if (shift) openFolder(); else openFiles(); }
    else if (ctrl && (k === 'u' || k === 'U')) openUrl();
    else if (ctrl && k.toLowerCase() === 'k') openCatalog();
    else if (ctrl && k === ',') togglePanel();
    else if (ctrl && (k === 'm' || k === 'M')) toggleMini();
    else if (ctrl && (k === 'i' || k === 'I')) { setSetting('smooth', !S.smooth); osd(S.smooth ? 'Płynny ruch włączony' : 'Płynny ruch wyłączony', S.renderer !== 'gl' ? 'wymaga renderera WebGL2' : ''); }
    else if (ctrl && (k === 'v' || k === 'V')) window.kadr.clipboardText().then(t => { t = (t || '').trim().replace(/^"|"$/g, ''); if (t) openPaths([t]); });
    else if (ctrl && (k === '=' || k === '+')) { setSetting('zoom', clamp(S.zoom + 0.1, 0.5, 3)); osd(`Powiększenie ${Math.round(S.zoom * 100)}%`); }
    else if (ctrl && k === '-') { setSetting('zoom', clamp(S.zoom - 0.1, 0.5, 3)); osd(`Powiększenie ${Math.round(S.zoom * 100)}%`); }
    else if (ctrl && k === '0') { setSetting('zoom', 1); if (cur) cur.pan = { x: 0, y: 0 }; osd('Powiększenie 100%'); }
    else if (ctrl && k.startsWith('Arrow')) {
      if (!cur) return;
      const d = 0.02;
      cur.pan = cur.pan || { x: 0, y: 0 };
      if (k === 'ArrowLeft') cur.pan.x += d; if (k === 'ArrowRight') cur.pan.x -= d; if (k === 'ArrowUp') cur.pan.y += d; if (k === 'ArrowDown') cur.pan.y -= d;
      dirty = true;
    }
    else if (k === ' ' || k === 'k' || k === 'K' || k === 'MediaPlayPause') togglePlay();
    else if (k === 'ArrowLeft') seekBy(shift ? -1 : -S.seekStep);
    else if (k === 'ArrowRight') seekBy(shift ? 1 : S.seekStep);
    else if (k === 'j' || k === 'J') seekBy(-10);
    else if (k === 'l' || k === 'L') seekBy(10);
    else if (k === 'ArrowUp') setVolume(S.volume + 0.05);
    else if (k === 'ArrowDown') setVolume(S.volume - 0.05);
    else if (k === 'm' || k === 'M') $('#b-mute').click();
    else if (k === 'f' || k === 'F' || (k === 'Enter' && e.altKey)) window.kadr.fullscreen();
    else if (k === 'Escape') {
      if ($('#modal').classList.contains('open')) $('#modal').classList.remove('open');
      else if (document.querySelector('.drawer.open')) closeDrawers();
      else if (app.classList.contains('fullscreen')) window.kadr.fullscreen(false);
      else if (app.classList.contains('mini')) toggleMini(false);
      else if (cur?.item.catalog) returnToCatalog();
    }
    else if (k === ',') frameStep(-1);
    else if (k === '.') frameStep(1);
    else if (k === '[') setSpeed((video.playbackRate || 1) - 0.1);
    else if (k === ']') setSpeed((video.playbackRate || 1) + 0.1);
    else if (k === 'Backspace') { if (cur?.item.catalog) returnToCatalog(); else setSpeed(1); }
    else if (k === 's' || k === 'S') screenshot();
    else if (k === 'v' || (remote && k === 'V')) $('#b-subs').click();
    else if (k === 'V') selectSub(-1);
    else if (k === 'b' || k === 'B') cycleAudio();
    else if (k === 'z' || k === 'Z') subDelay(-0.1);
    else if (k === 'x' || k === 'X') subDelay(0.1);
    else if (k === 'c' || k === 'C') toggleCrop();
    else if (k === 'a' || k === 'A') {
      const list = ['auto', '16:9', '4:3', '21:9', '2.35:1', '1:1'];
      setSetting('aspect', list[(list.indexOf(S.aspect) + 1) % list.length]);
      osd('Proporcje: ' + (S.aspect === 'auto' ? 'automatyczne' : S.aspect));
    }
    else if (k === 'r' || k === 'R') { setSetting('rotate', (S.rotate + 90) % 360); osd(`Obrót ${S.rotate}°`); }
    else if (k === 'd' || k === 'D') { setSetting('deband', !S.deband); osd(S.deband ? 'Usuwanie pasm włączone' : 'Usuwanie pasm wyłączone'); }
    else if (k === 'i' || k === 'I') toggleStats();
    else if (k === 't' || k === 'T') { setSetting('onTop', !S.onTop); osd(S.onTop ? 'Zawsze na wierzchu' : 'Zwykłe okno'); }
    else if (k === 'p' || k === 'P') toggleList();
    else if (k === 'n') playRelative(1);
    else if (k === 'N') playRelative(-1);
    else if (k === 'PageDown' || k === 'PageUp') {
      const ch = cur && cur.info && cur.info.chapters;
      if (ch && ch.length > 1) {
        const t = video.currentTime;
        const idx = ch.findIndex(c => t >= c.start - 0.5 && t < c.end);
        const ni = k === 'PageDown' ? idx + 1 : (t - (ch[idx] ? ch[idx].start : 0) > 3 ? idx : idx - 1);
        if (ni >= 0 && ni < ch.length) { engine.seek(ch[ni].start, true); osd(ch[ni].title || `Rozdział ${ni + 1}`, fmt(ch[ni].start)); }
      } else playRelative(k === 'PageDown' ? 1 : -1);
    }
    else if (k === 'MediaTrackNext') playRelative(1);
    else if (k === 'MediaTrackPrevious') playRelative(-1);
    else if (k === 'Home') { if (cur) { seekPlayback(0, true); osd('Od początku'); } }
    else if (k === 'End') { if (cur) seekPlayback(playbackDuration() - 1, true); }
    else if (/^[0-9]$/.test(k) && cur && playbackDuration()) { const t = playbackDuration() * (+k / 10); seekPlayback(t, true); osd(`${+k * 10}%`, fmt(t)); }
    else handled = false;
    if (handled) e.preventDefault();
  });

  // ---------- drag & drop ----------
  let dragDepth = 0;
  app.addEventListener('dragenter', e => { if (dragFrom >= 0) return; if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; app.classList.add('dropping'); } });
  app.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; app.classList.remove('dropping'); } });
  app.addEventListener('dragover', e => { if (dragFrom < 0) e.preventDefault(); });
  app.addEventListener('drop', e => {
    if (dragFrom >= 0) return;
    e.preventDefault();
    dragDepth = 0; app.classList.remove('dropping');
    const paths = [...e.dataTransfer.files].map(f => window.kadr.pathOf(f)).filter(Boolean);
    if (!paths.length) {
      const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (/^https?:\/\//i.test((t || '').trim())) openPaths([t.trim()]);
      return;
    }
    if (cur && paths.every(p => SUB_EXT.includes(ext(p)))) { paths.forEach((p, i) => addExternalSub(p, i === 0)); return; }
    openPaths(paths, { append: e.shiftKey });
  });

  window.kadr.onOpen(({ files, replace }) => openPaths(files, { append: !replace }));
  window.kadr.onMovieKey(key => app.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true })));
  window.kadr.onMovieStage(action => {
    if (remote) stage.dispatchEvent(new MouseEvent(action, { bubbles: true }));
  });
  window.kadr.onMoviePointer(() => { if (remote) { pointerOverControls = false; showUI(); } });
  window.kadr.onMovieMenu(() => { if (remote) { showUI(); popup(mainMenu()); } });

  // the GPU process died while Chromium decoded this codec → never trust its hardware decoder for it again
  window.kadr.onGpuCrash(() => {
    const v = engine.sel && engine.sel.video;
    if (!cur || !v || !['direct', 'copy'].includes(engine.mode)) return;
    const key = v.codec_name + (/p10|p12/.test(v.pix_fmt || '') ? '10' : '');
    S.badCodecs = Array.from(new Set([...(S.badCodecs || []), key]));
    saveSettings();
    osd('Karta graficzna nie radzi sobie z ' + key.toUpperCase(), 'przełączam na konwersję w locie (zapamiętane)', 3500);
    engine.failedModes = new Set();
    engine.ms = null; engine.sb = null;
    engine.start(video.currentTime || 0, null);
  });

  // ---------- start ----------
  setupRenderer();
  applyVolume();
  applySound();
  applySubStyle();
  if (S.sink && S.sink !== 'default') sound.setSink(S.sink);
  if (S.onTop) window.kadr.onTop(true);
  renderRecent();
  renderPlaylist();
  window.addEventListener('beforeunload', () => { saveResume(); window.kadr.saveSettings(S); window.kadr.saveState(ST); });
  requireLicense().then(() => { if (cfg.open && cfg.open.length) openPaths(cfg.open); });

  // test hooks (KADR_DEBUG=1)
  window.app = { S, ST, engine, sound, get gl() { return gl; }, get cur() { return cur; }, get playlist() { return playlist; }, openPaths, playIndex, setSetting, selectSub, toggleStats, screenshot, toggleMini, seekBy, osd, togglePanel, openPanel, toggleList, popupItems: () => mainMenu(), autoCrop,
    quality: { choose: chooseLocal, effect: () => qualityEffect(remote, null), menu: qualityMenu, get lastDst() { return lastDst; }, get menuOpen() { return nativeMenuOpen; } } };
  if (cfg.debug) {
    const code = await window.kadr.test.script();
    if (code) { try { await new Function('app', 'K', `return (async () => { ${code} })()`)(window.app, K); } catch (e) { window.kadr.test.log('TEST ERROR ' + (e && e.stack || e)); window.kadr.test.quit(); } }
  }
})();
