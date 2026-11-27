const assert = require('node:assert/strict');
const { movieCaptions } = require('../captions');
const { segmentsFromSrt, attachDetectedLanguages } = require('../local-whisper');
const { translateCues, languageCode } = require('../subtitle-translation');
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
  const second = { start: 13, end: 14, text: 'Test' };
  assert.deepEqual(attachDetectedLanguages([...segments, second], 'run transcription at 0 ms\nauto-detected language: pl\n' +
    'run transcription at 12000 ms\nauto-detected language: en'), [{ ...segments[0], lang: 'pl' }, { ...second, lang: 'en' }]);
  assert.equal(languageCode('Polish'), 'pl');
  assert.equal(languageCode('en-US'), 'en');
  const unchanged = [{ ...segments[0], lang: 'pl' }];
  assert.deepEqual(await translateCues('', unchanged, 'pl', new AbortController().signal), unchanged);
  assert.deepEqual(K.parseSubtitles(K.exportSrt(segments, 0.5)), [{ ...expected[0], start: 1.5, end: 4 }]);
  let video = { currentTime: 23.5, textTracks: [], addEventListener() {},
    addTextTrack(kind, label, language) {
      const t = Object.assign(new EventTarget(), { kind, label, language, cues: [], addCue(c) { this.cues.push(c); } });
      Object.defineProperty(t, 'activeCues', { get() {
        return this.mode === 'disabled' ? null : this.cues.filter(c => c.startTime <= video.currentTime && video.currentTime < c.endTime);
      } });
      this.textTracks.push(t);
      return t;
    } };
  global.VTTCue = class { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } };
  let hasMenu = false, open = false, entries = [];
  const request = window.fetch = async () => new Response(vtt, { headers: { 'content-type': 'text/vtt' } });
  const select = { options: [{ value: 'eng', label: 'English' }, { value: 'pol', label: 'Polish' }], value: 'eng',
    dispatchEvent() { entries = ['Kinowa','Rozszerzona'].map(textContent => ({ textContent, isConnected: true, click() { void window.fetch('https://example.test/sub.vtt'); } })); } };
  const menu = { classList: { contains: () => open }, querySelector: s => s === '.jw-select' ? select : { click() { open = false; } }, querySelectorAll: () => entries };
  global.CSSStyleSheet = class { replaceSync(css) { this.css = css; } };
  const element = () => ({ children: [], style: new Map(), append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; } });
  const root = element();
  global.document = { createElement: () => {
    const el = element();
    el.style.setProperty = el.style.set.bind(el.style);
    return el;
  }, adoptedStyleSheets: [], documentElement: root,
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
  const [top, bottom] = root.children[0].children;
  assert.deepEqual([t.cues[0].startTime, t.cues[0].endTime], [2.5, 5]);
  assert.equal(root.children[0].style.get('--kadr-caption-size'), '6vh');
  assert.equal(root.children[0].style.get('--kadr-caption-bg'), 'rgba(0,0,0,0.5)');
  await movieCaptions('style', { delay: -0.5, size: 5, bg: 1 });
  assert.equal(t.cues[0].startTime, 0.5);
  assert.equal(t.mode, 'hidden');
  video.currentTime = 1;
  t.dispatchEvent(new Event('cuechange'));
  assert.deepEqual(bottom.children[0].children[0].children, ['Próba']);
  assert.equal(top.children.length, 0);
  video.currentTime = 5;
  t.dispatchEvent(new Event('cuechange'));
  assert.equal(bottom.children.length, 0);
  video.currentTime = 1;
  t.dispatchEvent(new Event('cuechange'));
  assert.equal((await movieCaptions('list')).tracks[0].active, true);
  await movieCaptions('select', -1);
  assert.equal(t.mode, 'disabled');
  assert.equal(bottom.children.length, 0);
  assert.equal(video.currentTime, 1);
  const { kadrCaptions, ...fresh } = video;
  video = { ...fresh, textTracks: [] };
  const automatic = video.addTextTrack('subtitles', 'Domyślna', 'pol');
  automatic.mode = 'showing';
  await movieCaptions('init');
  await movieCaptions('auto', false);
  assert.equal(automatic.mode, 'disabled');
  assert.equal((await movieCaptions('list')).tracks[0].active, false);
  await movieCaptions('auto', true);
  assert.equal(automatic.mode, 'hidden');
  assert.equal((await movieCaptions('list')).tracks[0].active, true);
  await movieCaptions('add', { label: 'Własna', cues: expected });
  await movieCaptions('auto', false);
  assert.deepEqual((await movieCaptions('list')).tracks.map(({ active }) => active), [false, true]);
  console.log('OK: wybór i automatyczny wybór napisów, styl, synchronizacja, wyłączanie, SRT/VTT/ASS, eksport SRT.');
}

test().catch(error => { console.error(error); process.exitCode = 1; });
