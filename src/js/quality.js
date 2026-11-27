// cap is a preferred height, zero selects the best fixed level, -1 selects automatic.
function movieQuality(cap) {
  const video = document.querySelector('video[data-kadr-film]');
  if (!video) return null;
  const heightOf = s => Number(String(s || '').match(/(?:^|\D)(\d{3,4})(?:p|\s*$)/i)?.[1]) || 0;
  let levels = [], set, auto, current;
  const hls = video.hls || window.hls;
  let jw;
  try { jw = typeof window.jwplayer === 'function' && window.jwplayer(); } catch {}
  if (hls?.levels?.length && 'currentLevel' in hls) {
    levels = hls.levels.map((l,i) => ({ id: i, height: l.height, bitrate: l.bitrate || 0 }));
    set = i => { hls.nextLevel = i; };
    auto = -1;
    current = () => hls.autoLevelEnabled ? -1 : hls.currentLevel;
  } else if (jw?.getQualityLevels && jw.setCurrentQuality) {
    const options = jw.getQualityLevels() || [];
    levels = options.map((l,i) => ({ id: i, height: l.height || heightOf(l.label), bitrate: l.bitrate || 0 }));
    const index = options.findIndex(l => /auto/i.test(l.label));
    if (index >= 0) auto = index;
    set = i => jw.setCurrentQuality(i);
    current = () => jw.getCurrentQuality();
  } else {
    const controls = [...document.querySelectorAll('select')];
    const quality = controls.find(el => [...el.options].some(o => /^(?:\d{3,4}p(?:\s|$)|\d{3,4}$)/i.test(o.label.trim())));
    if (quality) {
      levels = Array.from(quality.options, (o,i) => ({ id: i, height: heightOf(o.label), bitrate: 0 }));
      const index = [...quality.options].findIndex(o => /auto/i.test(o.label));
      if (index >= 0) auto = index;
      current = () => quality.selectedIndex;
      set = i => { quality.selectedIndex = i; quality.dispatchEvent(new Event('change', { bubbles: true })); };
    }
  }
  levels = levels.filter(l => l.height > 0).sort((a,b) => a.height - b.height || a.bitrate - b.bitrate);
  if (Number.isFinite(cap) && set) {
    const fixed = cap === 0 ? levels.at(-1) : levels.filter(l => l.height <= cap).at(-1) || levels[0];
    const target = cap === -1 && auto != null ? auto : fixed?.id;
    if (target != null && current() !== target) set(target);
  }
  return { heights: [...new Set(levels.map(l => l.height))], auto: auto != null,
    height: video.videoHeight || 0, selected: levels.find(l => l.id === current?.())?.height || null };
}

const qualityProfiles = {
  best: { label: 'Najwyższa dostępna', cap: 0, renderer: 'gl', scaler: 'lanczos', linear: true, quality: 'max' },
  high: { label: 'Wysoka', cap: 1080, renderer: 'gl', scaler: 'catrom', linear: false, quality: 'balanced' },
  medium: { label: 'Średnia', cap: 720, renderer: 'gl', scaler: 'bilinear', linear: false, quality: 'fast' },
  low: { label: 'Niska', cap: 480, renderer: 'native', scaler: 'bilinear', linear: false, quality: 'fast' }
};

function localProfile(id) {
  const { cap, renderer, scaler, linear, quality } = qualityProfiles[id];
  return { renderer, scaler, linear, quality, maxHeight: cap, playMode: 'auto', interp: 'off', renderScale: 1,
    sharpen: 0, deband: false, smooth: false };
}

if (typeof module !== 'undefined') module.exports = { movieQuality, localProfile, qualityProfiles };
else Object.assign(window.K, { localProfile, qualityProfiles });
