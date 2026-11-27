const { execFile } = require('node:child_process');

// This function runs inside the playback frame. Credentials stay in the local app.
async function movieCaptions(action, value) {
  const video = document.querySelector('video[data-kadr-film]');
  if (!video) return null;
  const state = video.kadrCaptions ||= { size: 5.2, bg: 0, delay: 0, times: new WeakMap(), generation: 0 };
  const captionTracks = () => Array.from(video.textTracks).filter(t => ['captions', 'subtitles'].includes(t.kind));
  const tracks = captionTracks();
  const cc = document.querySelector('#ccBtn');
  const layer = document.querySelector('.jw-subs');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const menus = () => Array.from(document.querySelectorAll('.jw-menu'));
  function languageMenu() {
    let menu = menus().find(el => el.querySelector('.jw-select'));
    if (cc && !menu?.classList.contains('is-open')) {
      cc.click();
      menu = menus().find(el => el.querySelector('.jw-select'));
    }
    return menu;
  }
  const closeMenu = () => menus().find(el => el.classList.contains('is-open') && el.querySelector('.jw-select'))?.querySelector('.jw-menu-close')?.click();
  function styleTrack(track) {
    if (!track?.cues) return;
    for (const cue of Array.from(track.cues)) {
      const times = state.times.get(cue) || [cue.startTime, cue.endTime];
      state.times.set(cue, times);
      cue.startTime = Math.max(0, times[0] + state.delay);
      cue.endTime = Math.max(0, times[1] + state.delay);
    }
  }
  function selectTrack(selected, available) {
    state.selected?.removeEventListener('cuechange', state.render);
    state.selected = selected;
    for (const track of available) {
      const mode = track === selected ? 'hidden' : 'disabled';
      if (track.mode !== mode) track.mode = mode;
    }
    if (selected) {
      styleTrack(selected);
      selected.addEventListener('cuechange', state.render);
    }
    state.render();
  }
  if (action === 'init') {
    if (state.overlay) return true;
    const css = new CSSStyleSheet();
    css.replaceSync(`
      .jw-menu:has(.jw-select),.jw-menu:has(.jw-tabs){display:none!important}
      #kadr-caption-overlay{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none}
      #kadr-caption-overlay>div{position:absolute;left:5%;right:5%;text-align:center;
        font:650 var(--kadr-caption-size,5.2vh)/1.2 "Segoe UI",sans-serif;
        color:white;text-shadow:0 1px 3px black,1px 0 2px black;white-space:pre-line;overflow-wrap:anywhere}
      #kadr-caption-overlay>div:first-child{top:5%}
      #kadr-caption-overlay>div:last-child{bottom:5%}
      #kadr-caption-overlay .kadr-cue{background:var(--kadr-caption-bg,transparent);padding:0 .16em;box-decoration-break:clone}
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, css];
    const overlay = document.createElement('div');
    overlay.id = 'kadr-caption-overlay';
    const top = document.createElement('div'), bottom = document.createElement('div');
    overlay.append(top, bottom);
    document.documentElement.append(overlay);
    state.overlay = overlay;
    let visible = [];
    state.render = () => {
      const cues = Array.from(state.selected?.activeCues || []);
      if (cues.length === visible.length && cues.every((cue, i) => cue === visible[i])) return;
      visible = cues;
      top.replaceChildren();
      bottom.replaceChildren();
      for (const cue of cues) {
        const line = document.createElement('div'), text = document.createElement('span');
        text.className = 'kadr-cue';
        // VTTCue builds a fragment using the WebVTT markup rules.
        text.append(cue.getCueAsHTML ? cue.getCueAsHTML() : cue.text);
        line.append(text);
        (cue.kadrTop || (typeof cue.line === 'number' && cue.line >= 0 && (!cue.snapToLines || cue.line <= 2) && cue.line < 50) ? top : bottom).append(line);
      }
    };
    for (const event of ['timeupdate', 'seeked', 'emptied']) video.addEventListener(event, state.render);
    video.addEventListener('load', event => {
      const track = event.target.track;
      if (track && track === state.selected) styleTrack(track);
    }, true);
    state.syncAutomatic = () => {
      if (state.applying || (state.auto === undefined && !state.manual)) return;
      const available = captionTracks();
      const showing = available.find(track => track.mode === 'showing');
      if (state.manual) {
        if (showing) selectTrack(state.selected, available);
        return;
      }
      if (showing) state.automatic = showing;
      const selected = state.auto && available.includes(state.automatic) ? state.automatic : undefined;
      if (showing || selected !== state.selected) selectTrack(selected, available);
    };
    video.textTracks.addEventListener?.('change', state.syncAutomatic);
    return true;
  }
  if (action === 'auto') {
    if (value && state.auto === false && !state.selected) state.manual = false;
    state.auto = !!value;
    state.syncAutomatic();
    return true;
  }
  if (action === 'style') {
    state.size = Math.max(2.5, Math.min(10, +value.size));
    state.bg = Math.max(0, Math.min(1, +value.bg));
    state.delay = Number(value.delay) || 0;
    state.overlay.style.setProperty('--kadr-caption-size', state.size + 'vh');
    state.overlay.style.setProperty('--kadr-caption-bg', 'rgba(0,0,0,' + state.bg + ')');
    if (state.selected) styleTrack(state.selected);
    state.render();
    return true;
  }
  if (action === 'list') {
    const menu = languageMenu();
    const langs = Array.from(menu?.querySelector('.jw-select')?.options || [])
      .filter(o => o.value && !o.disabled).map(o => ({ code: o.value, label: o.label }));
    return { langs, tracks: tracks.map((t, index) => ({ index, label: t.label || 'Ścieżka ' + (index + 1),
      lang: t.language, active: t === state.selected || (!state.selected && t.mode === 'showing'), source: t.kadrSource || null })) };
  }
  const rows = menu => Array.from(menu?.querySelectorAll('.jw-result') || []);
  if (action === 'versions') {
    const generation = ++state.generation;
    const menu = languageMenu(), select = menu?.querySelector('.jw-select');
    if (!select || !Array.from(select.options).some(o => o.value === value)) return [];
    const changed = select.value !== value;
    const before = changed ? rows(menu) : [];
    if (changed || !rows(menu).length) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (let n = 0; n < 50; n++) {
      if (state.generation !== generation) return [];
      const entries = rows(menu);
      if (entries.length && !entries.some(el => before.includes(el))) {
        state.entries = entries;
        return entries.map((el, i) => ({ index: i, label: (el.textContent.trim()
          .replace(/(\.(?:srt|vtt|ass|ssa|sub))\s*(\d{1,3}%)\s*↓\s*([\d,.]+)$/i, '$1 · $2 · ↓ $3')
          || 'Wersja ' + (i + 1)).slice(0, 240) }));
      }
      await sleep(150);
    }
    state.entries = [];
    return [];
  }
  if (action === 'dismiss') { ++state.generation; closeMenu(); return true; }
  if (action === 'apply') {
    const entry = state.entries?.[value.index];
    if (!entry?.isConnected || languageMenu()?.querySelector('.jw-select')?.value !== value.lang) throw Error('Odśwież listę wersji napisów.');
    // The provider loads the selected file itself. Reuse the timed text it decodes.
    const previousFetch = window.fetch;
    let complete;
    const loaded = new Promise(resolve => { complete = resolve; });
    function inspect(payload) {
      if (typeof payload === 'string') {
        if (/^\s*(WEBVTT|\[Script Info\])/i.test(payload) || /^[\s\S]{0,3000}\d{2}:\d{2}[\s\S]{0,24}-->/.test(payload)) complete({ body: payload });
        return;
      }
      if (Array.isArray(payload)) {
        const cues = payload.filter(c => typeof c?.text === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
        if (cues.length) complete({ cues });
      } else if (payload && typeof payload === 'object') {
        for (const key of ['srt', 'vtt', 'content', 'cues', 'subtitles', 'data']) if (payload[key]) inspect(payload[key]);
      }
    }
    async function inspectResponse(response) {
      const type = response.headers.get('content-type') || '';
      if (!response.ok || Number(response.headers.get('content-length')) > 8000000 ||
          !(/text|subrip|vtt|json/i.test(type) || /\.(vtt|srt|ass)(\?|$)/i.test(response.url))) return;
      const reader = response.clone().body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let body = '', length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 8000000) { void reader.cancel(); return; }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      if (/^\s*[\[{]/.test(body) && !/^\s*\[Script Info\]/i.test(body)) inspect(JSON.parse(body));
      else inspect(body);
    }
    async function fetchSelection(...args) {
      const response = await previousFetch.apply(this, args);
      // Some players serve subtitle files as generic binary data, then call text() or json().
      // Observe their decoded value without consuming the original response stream.
      for (const method of ['text', 'json']) {
        const decode = response[method].bind(response);
        response[method] = async () => {
          const result = await decode();
          if (typeof result !== 'string' || result.length <= 8000000) inspect(result);
          return result;
        };
      }
      void inspectResponse(response).catch(() => {});
      return response;
    }
    window.fetch = fetchSelection;
    let timer;
    state.applying = true;
    try {
      entry.click();
      const result = await Promise.race([loaded, new Promise(done => { timer = setTimeout(() => done(null), 8000); })]);
      if (result) return result;
      const track = captionTracks().find(t => t.mode === 'showing' && t.cues?.length && !tracks.includes(t));
      if (track) {
        await movieCaptions('select', Array.from(video.textTracks).filter(t => ['captions', 'subtitles'].includes(t.kind)).indexOf(track));
        return { native: true };
      }
      throw Error('Odtwarzacz nie udostępnił treści tej wersji napisów.');
    } finally {
      state.applying = false;
      clearTimeout(timer);
      if (window.fetch === fetchSelection) window.fetch = previousFetch;
      closeMenu();
    }
  }
  let selected;
  if (action === 'select') selected = tracks[value];
  else if (action === 'add') {
    if (!value.cues?.length) return false;
    selected = video.addTextTrack('subtitles', value.label.slice(0, 240), value.lang || '');
    selected.kadrSource = value.source || null;
    selected.mode = 'hidden';
    for (const c of value.cues) if (Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start) {
      const cue = new VTTCue(c.start, c.end, c.text);
      cue.kadrTop = c.top;
      selected.addCue(cue);
    }
  } else return false;
  closeMenu();
  if (layer) layer.style.setProperty('visibility', 'hidden', 'important');
  state.manual = true;
  selectTrack(selected, tracks);
  return true;
}
// Capture only the selected video's audio, using the browser's media permissions.
async function captureMovieAudio(start, length) {
  const v = document.querySelector('video[data-kadr-film]');
  if (!v || !v.captureStream || !Number.isFinite(v.duration)) throw Error('Ten odtwarzacz nie udostępnia dźwięku filmu.');
  if (Math.abs(v.currentTime - start) > 0.25) v.currentTime = start;
  await new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); window.removeEventListener('kadr-stop-capture', fail); };
    const fail = () => { clear(); reject(Error('Przerwano oczekiwanie na dźwięk filmu.')); };
    const timer = setTimeout(fail, 15000);
    window.addEventListener('kadr-stop-capture', fail, { once: true });
    v.play().then(() => { clear(); resolve(); }, fail);
  });
  let stream;
  try { stream = v.captureStream(); }
  catch { throw Error('Dostawca nie udostępnia dźwięku do transkrypcji.'); }
  const tracks = stream.getAudioTracks();
  const cleanup = () => stream.getTracks().forEach(t => t.stop());
  if (!tracks.length) { cleanup(); throw Error('Brak dostępnej ścieżki dźwiękowej filmu.'); }
  let recorder;
  try { recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 }); }
  catch { cleanup(); throw Error('Nie można nagrać ścieżki dźwiękowej.'); }
  const chunks = [];
  let lastTime = v.currentTime, lastMove = Date.now(), error;
  const offset = lastTime;
  const cancel = () => { error = 'Anulowano generowanie.'; };
  window.addEventListener('kadr-stop-capture', cancel);
  try {
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (v.currentTime !== lastTime) { lastTime = v.currentTime; lastMove = Date.now(); }
        if (Date.now() - lastMove > 14000) error = 'Odtwarzacz przestał przesyłać dźwięk.';
        if (error || v.ended || v.currentTime >= start + length - 0.08) {
          clearInterval(timer);
          recorder.stop();
          v.pause();
        } else if (v.readyState < 3 && recorder.state === 'recording') recorder.pause();
        else if (v.readyState >= 3 && recorder.state === 'paused') recorder.resume();
      }, 100);
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => { clearInterval(timer); error ? reject(Error(error)) : resolve(); };
      recorder.onerror = () => { clearInterval(timer); reject(Error('Błąd nagrywania dźwięku.')); };
      recorder.start();
    });
    if (tracks.every(t => t.muted)) throw Error('Dostawca zablokował dostęp do dźwięku filmu.');
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { audio: btoa(binary), offset, end: v.currentTime };
  } finally { window.removeEventListener('kadr-stop-capture', cancel); cleanup(); }
}

function localAudio(ffmpeg, file, start, seconds, stream, signal) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(start), '-i', file, '-t', String(seconds),
      '-map', Number.isSafeInteger(stream) ? '0:' + stream : '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1'],
    { windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 120000, signal },
    (err, out) => err || !out.length ? reject(Error('Nie można odczytać dźwięku z pliku.')) : resolve(out));
  });
}

async function transcribe(audio, filename, key, signal) {
  const form = new FormData();
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('file', new Blob([audio]), filename);
  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(90000)])
  });
  if (response.status === 401 || response.status === 403) throw Error('Groq odrzucił klucz API.');
  if (response.status === 429) throw Error('Wyczerpano limit Groq. Spróbuj później.');
  if (!response.ok) throw Error('Usługa Groq zwróciła błąd HTTP ' + response.status + '.');
  const { segments } = await response.json();
  if (!Array.isArray(segments)) throw Error('Groq nie zwrócił znaczników czasu.');
  return segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.text === 'string' && s.text.trim() && !(s.no_speech_prob >= 0.9))
    .map(s => ({ start: s.start, end: s.end, text: s.text.trim().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }));
}

module.exports = { movieCaptions, captureMovieAudio, localAudio, transcribe };
