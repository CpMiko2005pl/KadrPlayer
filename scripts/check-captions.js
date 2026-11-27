const assert = require('node:assert/strict');
const { movieCaptions } = require('../captions');
const { segmentsFromSrt } = require('../local-whisper');
global.window = global;
global.K = {};
require('../src/js/subs');

async function test() {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\nPróba\n';
  const expected = K.parseSubtitles(srt);
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.500\nPróba';
  const ass = '[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Próba';
  assert.deepEqual(K.parseSubtitles(vtt), expected);
  assert.deepEqual(K.parseSubtitles(ass).map(c => ({ ...c, top: !!c.top })), expected);
  const segments = segmentsFromSrt(srt);
  assert.deepEqual(segments, [{ start: 1, end: 3.5, text: 'Próba' }]);
  assert.deepEqual(K.parseSubtitles(K.exportSrt(segments, 0.5)), [{ ...expected[0], start: 1.5, end: 4 }]);
  const video = { currentTime: 23.5, textTracks: [], addEventListener() {},
    addTextTrack(kind, label, language) {
      const t = { kind, label, language, cues: [], addCue(c) { this.cues.push(c); } };
      this.textTracks.push(t);
      return t;
    } };
  global.VTTCue = class { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } };
  let hasMenu = false, open = false, entries = [];
  const request = window.fetch = async () => new Response(vtt, { headers: { 'content-type': 'text/vtt' } });
  const select = { options: [{ value: 'eng', label: 'English' }, { value: 'pol', label: 'Polish' }], value: 'eng',
    dispatchEvent() { entries = ['Kinowa','Rozszerzona'].map(textContent => ({ textContent, isConnected: true, click() { void window.fetch('https://example.test/sub.vtt'); } })); } };
  const menu = { classList: { contains: () => open }, querySelector: s => s === '.jw-select' ? select : { click() { open = false; } }, querySelectorAll: () => entries };
  const css = {};
  global.document = { createElement: () => css, head: { append() {} }, getElementById: () => css,
    querySelectorAll: () => hasMenu ? [menu] : [], querySelector(s) {
      if (s === '#ccBtn') return hasMenu ? { click() { open = true; } } : null;
      return s.startsWith('video') ? video : null;
    } };
  await movieCaptions('init');
  assert.deepEqual(await movieCaptions('list'), { tracks: [], langs: [] });
  hasMenu = true;
  assert.equal((await movieCaptions('list')).langs.length, 2);
  const versions = await movieCaptions('versions', 'pol');
  assert.deepEqual(versions.map(t => t.label), ['Kinowa', 'Rozszerzona']);
  const selected = await movieCaptions('apply', { lang: 'pol', index: 1 });
  assert.equal(selected.body, vtt);
  assert.equal(window.fetch, request);
  await movieCaptions('add', { label: versions[1].label, lang: 'pol', cues: K.parseSubtitles(selected.body) });
  await movieCaptions('style', { delay: 1.5, size: 6, bg: 0.5 });
  const t = video.textTracks[0];
  assert.deepEqual([t.cues[0].startTime, t.cues[0].endTime], [2.5, 5]);
  assert.match(css.textContent, /6vh/);
  assert.match(css.textContent, /rgba\(0,0,0,0.5\)/);
  await movieCaptions('style', { delay: -0.5, size: 5, bg: 1 });
  assert.equal(t.cues[0].startTime, 0.5);
  assert.equal((await movieCaptions('list')).tracks[0].active, true);
  await movieCaptions('select', -1);
  assert.equal(t.mode, 'disabled');
  assert.equal(video.currentTime, 23.5);
  console.log('OK: pusty katalog napisów, dwie wersje polskie, wybór, styl, synchronizacja, wyłączenie, SRT/VTT/ASS, eksport SRT.');
}

test().catch(error => { console.error(error); process.exitCode = 1; });
