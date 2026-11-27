const { execFile } = require('node:child_process');

// This function runs inside the playback frame. Credentials stay in the local app.
function movieCaptions(action, value) {
  const video = document.querySelector('video[data-kadr-film]');
  if (!video) return null;
  const providerButton = document.querySelector('#ccBtn');
  const providerLayer = document.querySelector('.jw-subs');
  const tracks = Array.from(video.textTracks).filter(t => ['captions', 'subtitles'].includes(t.kind));
  const providerMenu = () => [...document.querySelectorAll('.jw-menu')].find(el => el.querySelector('.jw-select,.jw-tabs'));
  const reveal = el => {
    if (!el) return;
    for (const name of ['visibility', 'opacity', 'pointer-events']) el.style.removeProperty(name);
    el.style.setProperty('z-index', '2147483647', 'important');
  };
  if (action === 'list') return {
    provider: !!(providerButton && providerLayer),
    providerOn: !!(providerLayer && providerLayer.style.visibility !== 'hidden' && providerButton?.classList.contains('active')),
    tracks: tracks.map((t, i) => ({ label: (t.label || t.language || 'Napisy ' + (i + 1)).slice(0, 180), active: t.mode === 'showing' }))
  };
  if (action === 'init') { reveal(providerLayer); return; }
  if (action === 'provider') {
    if (!providerButton || !providerLayer) return false;
    for (const t of tracks) t.mode = 'disabled';
    reveal(providerLayer);
    if (!providerMenu()?.classList.contains('is-open')) providerButton.click();
    const menu = providerMenu();
    reveal(menu);
    return !!menu;
  }
  let selected;
  if (action === 'select') selected = tracks[value];
  else if (action === 'add') {
    if (!value.cues.length) return false;
    const label = value.label.slice(0, 180);
    selected = video.addTextTrack('subtitles', label);
    selected.mode = 'hidden';
    for (const { start, end, text } of value.cues) {
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) selected.addCue(new VTTCue(start, end, text));
    }
  } else return false;
  if (providerLayer) providerLayer.style.setProperty('visibility', 'hidden', 'important');
  if (providerMenu()?.classList.contains('is-open')) providerMenu().querySelector('.jw-menu-close')?.click();
  for (const track of tracks) track.mode = track === selected ? 'showing' : 'disabled';
  if (selected) selected.mode = 'showing';
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
