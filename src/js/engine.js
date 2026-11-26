// Kadr Player — playback engine
// For every file: ffprobe → pick streams → choose the cheapest path that Chromium can show:
//   direct  the file itself (MP4/WebM/MKV/MP3/FLAC… with supported codecs)
//   copy    ffmpeg repackages to fragmented MP4 without touching the picture (MKV with AC3, AVI with H.264, TS, …)
//   encode  ffmpeg converts the picture on the fly (MPEG-2, WMV, Xvid, ProRes, 10-bit H.264, interlaced, burned-in subtitles…)
// copy/encode go through MediaSource; the fragments keep real timestamps, so seeking works like in a normal file.
// When a path fails it falls back: direct → copy → encode.
window.K = window.K || {};
(() => {
  const BITMAP_SUBS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'pgssub', 'dvdsub'];
  const COPY_VIDEO = ['h264', 'hevc', 'vp9', 'av1'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rate = s => { if (!s || s === '0/0') return 0; const [a, b] = String(s).split('/').map(Number); return b ? a / b : a; };

  class Emitter {
    constructor() { this.h = {}; }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    emit(e, ...a) { for (const f of this.h[e] || []) { try { f(...a); } catch (x) { console.error(x); } } }
  }

  function detectSupport() {
    const ms = m => { try { return window.MediaSource && MediaSource.isTypeSupported(m); } catch { return false; } };
    const v = document.createElement('video');
    const can = m => v.canPlayType(m) !== '';
    return {
      h264: ms('video/mp4; codecs="avc1.640033"'),
      hevc: ms('video/mp4; codecs="hvc1.1.6.L153.B0"'),
      hevc10: ms('video/mp4; codecs="hvc1.2.4.L153.B0"'),
      vp9: ms('video/mp4; codecs="vp09.00.51.08"'),
      vp9p2: ms('video/mp4; codecs="vp09.02.51.10"'),
      av1: ms('video/mp4; codecs="av01.0.15M.08"'),
      av1_10: ms('video/mp4; codecs="av01.0.15M.10"'),
      vp8: can('video/webm; codecs="vp8"'),
      theora: can('video/ogg; codecs="theora"'),
      aac: ms('audio/mp4; codecs="mp4a.40.2"'),
      mp3: ms('audio/mp4; codecs="mp4a.6B"') || ms('audio/mpeg'),
      opus: ms('audio/mp4; codecs="opus"'),
      flac: ms('audio/mp4; codecs="flac"'),
      vorbis: can('audio/ogg; codecs="vorbis"'),
    };
  }

  function analyze(probe, input) {
    const streams = probe.streams || [];
    const fmt = probe.format || {};
    const isCover = s => s.disposition && s.disposition.attached_pic;
    const video = streams.filter(s => s.codec_type === 'video' && !isCover(s) && s.codec_name !== 'mjpeg' || (s.codec_type === 'video' && s.codec_name === 'mjpeg' && !isCover(s) && rate(s.avg_frame_rate) > 1));
    const audio = streams.filter(s => s.codec_type === 'audio');
    const subs = streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({ ...s, rel: i, bitmap: BITMAP_SUBS.includes(s.codec_name) }));
    const cover = streams.find(isCover);
    const v = video[0];
    const durations = [fmt.duration, v && v.duration, audio[0] && audio[0].duration].map(Number).filter(x => x > 0);
    return {
      input, probe,
      container: fmt.format_name || '',
      containerLong: fmt.format_long_name || '',
      duration: durations.length ? Math.max(...durations) : 0,
      startTime: Math.max(0, +fmt.start_time || 0),
      bitrate: +fmt.bit_rate || 0,
      size: +fmt.size || 0,
      tags: fmt.tags || {},
      video, audio, subs, cover,
      chapters: (probe.chapters || []).map(c => ({ start: +c.start_time, end: +c.end_time, title: (c.tags && c.tags.title) || '' })),
    };
  }

  K.streamFps = s => (s ? rate(s.avg_frame_rate) || rate(s.r_frame_rate) : 0);
  K.isHDR = s => !!s && ['smpte2084', 'arib-std-b67'].includes(s.color_transfer);
  K.isInterlaced = s => !!s && ['tt', 'bb', 'tb', 'bt'].includes(s.field_order);
  K.langName = code => ({ pol: 'polski', pl: 'polski', eng: 'angielski', en: 'angielski', ger: 'niemiecki', deu: 'niemiecki', fre: 'francuski', fra: 'francuski', spa: 'hiszpański', ita: 'włoski', rus: 'rosyjski', ukr: 'ukraiński', jpn: 'japoński', kor: 'koreański', chi: 'chiński', zho: 'chiński', cze: 'czeski', ces: 'czeski', slo: 'słowacki', por: 'portugalski', dut: 'niderlandzki', nld: 'niderlandzki', swe: 'szwedzki', nor: 'norweski', dan: 'duński', fin: 'fiński', hun: 'węgierski', tur: 'turecki', ara: 'arabski', heb: 'hebrajski', hin: 'hindi', und: '' }[String(code || '').toLowerCase()] ?? String(code || ''));

  class Engine extends Emitter {
    constructor(video, cfg) {
      super();
      this.video = video;
      this.cfg = cfg;              // { base, token, settings: () => settings, encoder: () => name }
      this.sup = detectSupport();
      this.gen = 0;
      this.sgen = 0;
      this.info = null;
      this.mode = null;            // 'direct' | 'copy' | 'encode'
      this.sel = {};
      this.ms = null; this.sb = null;
      this.ended = false;
      this.wantPlay = true;
      video.addEventListener('error', () => this.onVideoError());
      video.addEventListener('waiting', () => { this.jumpGap(); this.noteStall(); });
      video.addEventListener('loadeddata', () => this.checkDecoded());
      this.gapTimer = setInterval(() => { if (this.mode && this.mode !== 'direct' && !video.paused) this.jumpGap(); }, 400);
    }
    S() { return this.cfg.settings(); }
    url(path, q) {
      const p = new URLSearchParams(Object.assign({ k: this.cfg.token }, q));
      return `${this.cfg.base}${path}?${p}`;
    }
    fileUrl(input) { return /^https?:/i.test(input) ? this.url('/file', { u: input }) : this.url('/file', { p: input }); }

    videoOK(v) {
      if (!v) return true;
      const pf = v.pix_fmt || '';
      const b10 = /p10|p12/.test(pf);
      const s420 = /^(yuv420p|yuvj420p|yuv420p10le|nv12|p010le)$/.test(pf) || !pf;
      if (!s420) return false;
      // codecs that crashed the GPU process on this PC are remembered and converted instead
      if ((this.S().badCodecs || []).includes(v.codec_name + (b10 ? '10' : ''))) return false;
      switch (v.codec_name) {
        case 'h264': return !b10 && this.sup.h264;
        case 'hevc': return b10 ? this.sup.hevc10 : this.sup.hevc;
        case 'vp9': return b10 ? this.sup.vp9p2 : this.sup.vp9;
        case 'av1': return b10 ? this.sup.av1_10 : this.sup.av1;
        case 'vp8': return this.sup.vp8;
        case 'theora': return this.sup.theora;
        default: return false;
      }
    }
    audioDirectOK(a) {
      if (!a) return true;
      const c = a.codec_name;
      if (c === 'aac') return this.sup.aac;
      if (c === 'mp3') return this.sup.mp3;
      if (c === 'opus') return this.sup.opus;
      if (c === 'flac') return this.sup.flac;
      if (c === 'vorbis') return this.sup.vorbis;
      return /^pcm_(s16le|s24le|s32le|f32le|u8)$/.test(c);
    }
    audioCopyOK(a) {
      if (!a) return true;
      if (this.forceAudioEnc) return false;
      if (this.S().stereo && (a.channels || 2) > 2) return false;
      // MP3 inside fragmented MP4 is refused by MediaSource here, so it is converted to AAC (cheap)
      return (a.codec_name === 'aac' && this.sup.aac && !/HE-AACv2/.test(a.profile || '')) || (a.codec_name === 'opus' && this.sup.opus) || (a.codec_name === 'flac' && this.sup.flac);
    }
    directContainer(info, v, a) {
      const f = info.container;
      if (/^https?:/i.test(info.input) && /hls|dash/.test(f)) return false;
      if (/mov|mp4/.test(f)) return !v || ['h264', 'hevc', 'av1', 'vp9'].includes(v.codec_name);
      if (/matroska|webm/.test(f)) return !v || ['h264', 'hevc', 'av1', 'vp9', 'vp8'].includes(v.codec_name);
      if (/^ogg/.test(f)) return !v || ['theora', 'vp8'].includes(v.codec_name);
      if (!v && /^(mp3|flac|wav|aac|ogg)$/.test(f)) return true;
      return false;
    }
    needsEncode(info, v) {
      const S = this.S();
      const r = [];
      if (!v) return r;
      if (!this.videoOK(v) || !COPY_VIDEO.includes(v.codec_name) && !['vp8', 'theora'].includes(v.codec_name)) r.push('kodek ' + v.codec_name + (v.pix_fmt ? ' ' + v.pix_fmt : ''));
      if ((S.deint === 'on') || (S.deint !== 'off' && K.isInterlaced(v))) r.push('usuwanie przeplotu');
      if (S.interp && S.interp !== 'off') r.push('interpolacja klatek');
      if (this.sel.burn) r.push('wypalanie napisów');
      if (S.playMode === 'encode') r.push('wymuszona konwersja');
      return r;
    }

    // what an http(s) address really is (a web page, a video file…) — asked through our proxy
    async urlType(address) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 10000);
        const res = await fetch(this.fileUrl(address), { headers: { Range: 'bytes=0-1023' }, signal: ctl.signal });
        clearTimeout(t);
        const type = res.headers.get('content-type') || '';
        ctl.abort();
        return type;
      } catch { return ''; }
    }

    // ---------- loading ----------
    async load(item, opts = {}) {
      const gen = ++this.gen;
      this.teardown();
      this.item = item;
      this.info = null;
      this.ended = false;
      this.loading = true;
      this.forceAudioEnc = false;
      this.autoMaxHeight = 0;
      this.stalls = [];
      this.wantPlay = opts.paused ? false : true;
      this.emit('loading', item);
      let probe = null;
      try { probe = opts.probe || await window.kadr.probe(item.path); }
      catch (e) {
        if (gen !== this.gen) return;
        if (!/^https?:/i.test(item.path)) { this.loading = false; this.emit('error', 'Nie można odczytać pliku: ' + e.message, { retry: false }); return; }
        const type = await this.urlType(item.path);
        if (gen !== this.gen) return;
        if (/text\/html|application\/xhtml/i.test(type) && !opts.fromPage) {
          // a web page: look for a direct video link in it and play that
          this.emit('page-search', item.path);
          let res = null;
          try { res = await window.kadr.findInPage(item.path); } catch {}
          if (gen !== this.gen) return;
          const links = (res && res.links) || [];
          for (const link of links.slice(0, 4)) {
            let p = null;
            try { p = await window.kadr.probe(link); } catch {}
            if (gen !== this.gen) return;
            if (p && (p.streams || []).some(s => s.codec_type === 'video' || s.codec_type === 'audio')) {
              this.loading = false;
              this.emit('page-found', { page: item.path, url: link, title: res.title });
              return this.load({ path: link, title: res.title || item.title, page: item.path }, Object.assign({}, opts, { fromPage: true, probe: p }));
            }
          }
          this.loading = false;
          this.emit('error', 'Na tej stronie nie ma bezpośredniego linku do filmu (np. film jest w odtwarzaczu osadzonym z innego serwisu albo wymaga logowania). Odtwarzacz potrzebuje linku do pliku (.mp4, .mkv, .webm…) albo strumienia .m3u8.', { retry: false });
          return;
        }
        probe = { streams: [], format: {} };
      }
      if (gen !== this.gen) return;
      this.loading = false;
      const info = analyze(probe, item.path);
      if (!info.video.length && !info.audio.length) {
        // nothing ffprobe could read: a local file is broken; an address may still play in Chromium itself
        if (!/^https?:/i.test(item.path)) { this.emit('error', 'Ten plik nie zawiera obrazu ani dźwięku albo jest uszkodzony.', { retry: false }); return; }
        this.info = info; this.sel = { video: null, audio: null, burn: null };
        this.mode = 'direct'; this.reasons = []; this.failedModes = new Set(['copy', 'encode']);
        this.emit('info', info); this.emit('mode', 'direct', []);
        return this.startDirect(opts.start || 0);
      }
      this.info = info;
      const S = this.S();
      this.sel = {
        video: info.video[0] || null,
        audio: pickByLang(info.audio, S.audioLang) || null,
        burn: null,
      };
      if (opts.audioIndex !== undefined) this.sel.audio = info.audio.find(a => a.index === opts.audioIndex) || this.sel.audio;
      if (!info.video.length && !info.audio.length && probe.streams.length) { this.emit('error', 'Ten plik nie zawiera obrazu ani dźwięku.'); return; }
      this.emit('info', info);
      await this.start(opts.start || 0, null);
    }

    plan(force) {
      const info = this.info, v = this.sel.video, a = this.sel.audio;
      const S = this.S();
      const enc = this.needsEncode(info, v);
      const reasons = [];
      let mode;
      if (force) mode = force;
      else if (enc.length) { mode = 'encode'; reasons.push(...enc); }
      else if (S.playMode === 'auto' && this.directContainer(info, v, a) && this.videoOK(v) && this.audioDirectOK(a) && this.directAudioSelectable()) mode = 'direct';
      else {
        mode = v ? (COPY_VIDEO.includes(v.codec_name) && this.videoOK(v) ? 'copy' : 'encode') : 'copy';
        if (mode === 'encode') reasons.push('kodek ' + (v && v.codec_name));
        if (!this.directContainer(info, v, a)) reasons.push('kontener ' + info.container.split(',')[0]);
        if (a && !this.audioDirectOK(a)) reasons.push('dźwięk ' + a.codec_name);
      }
      if (force === 'encode' && !v) mode = 'copy';
      return { mode, reasons };
    }
    directAudioSelectable() {
      const a = this.sel.audio, list = this.info.audio;
      if (!a || list.length < 2) return true;
      if (list[0] === a) return true;
      return !!this.video.audioTracks;          // switchable later with the AudioVideoTracks API
    }

    async start(at, force) {
      const p = this.plan(force);
      this.mode = p.mode;
      this.reasons = p.reasons;
      this.failedModes = this.failedModes || new Set();
      this.emit('mode', p.mode, p.reasons);
      if (p.mode === 'direct') return this.startDirect(at);
      return this.startMSE(at);
    }

    teardown() {
      this.sgen++;
      if (this.ctrl) { try { this.ctrl.abort(); } catch {} this.ctrl = null; }
      const v = this.video;
      v.pause();
      v.removeAttribute('src');
      try { v.load(); } catch {}
      if (this.msUrl) { URL.revokeObjectURL(this.msUrl); this.msUrl = null; }
      this.ms = null; this.sb = null;
      this.mode = null;
      this.failedModes = new Set();
    }

    startDirect(at) {
      const v = this.video;
      this.sgen++;
      if (this.ctrl) { try { this.ctrl.abort(); } catch {} this.ctrl = null; }
      this.ms = null; this.sb = null;
      v.crossOrigin = 'anonymous';
      v.src = this.fileUrl(this.info.input);
      const go = () => {
        v.removeEventListener('loadedmetadata', go);
        if (at > 0) v.currentTime = at;
        this.applyDirectAudio();
        if (this.wantPlay) v.play().catch(() => {});
      };
      v.addEventListener('loadedmetadata', go);
    }
    applyDirectAudio() {
      const tracks = this.video.audioTracks;
      if (!tracks || !this.sel.audio || this.info.audio.length < 2) return;
      const pos = this.info.audio.indexOf(this.sel.audio);
      for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === pos;
    }

    mime() {
      const v = this.mode === 'copy' ? this.sel.video : null;
      const codecs = [];
      if (this.sel.video) {
        if (this.mode === 'encode') codecs.push('avc1.640033');
        else {
          const b10 = /p10/.test(v.pix_fmt || '');
          codecs.push({ h264: 'avc1.640033', hevc: b10 ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0', vp9: b10 ? 'vp09.02.51.10' : 'vp09.00.51.08', av1: b10 ? 'av01.0.15M.10' : 'av01.0.15M.08' }[v.codec_name]);
        }
      }
      if (this.sel.audio) {
        const a = this.sel.audio;
        codecs.push(this.audioCopyOK(a) ? { aac: 'mp4a.40.2', mp3: 'mp4a.6B', opus: 'opus', flac: 'flac' }[a.codec_name] : 'mp4a.40.2');
      }
      return `${this.sel.video ? 'video' : 'audio'}/mp4; codecs="${codecs.join(',')}"`;
    }

    spec(ss) {
      const S = this.S();
      const v = this.sel.video, a = this.sel.audio;
      const enc = this.mode === 'encode';
      return {
        input: this.info.input, ss: Math.max(0, ss),
        vi: v ? v.index : -1, ai: a ? a.index : -1,
        video: !v ? 'none' : enc ? 'encode' : 'copy',
        vcodec: v ? v.codec_name : '',
        audio: !a ? 'none' : this.audioCopyOK(a) ? 'copy' : 'encode',
        encoder: this.cfg.encoder(), quality: S.quality || 'balanced',
        maxHeight: Math.min(...[+S.maxHeight || 1e9, this.autoMaxHeight || 1e9]) % 1e9 || 0, height: v ? v.height : 0, fps: K.streamFps(v) || 25,
        deint: enc && (S.deint === 'on' || (S.deint !== 'off' && K.isInterlaced(v))),
        tonemap: enc && S.tonemap !== false && K.isHDR(v),
        interp: enc && S.interp && S.interp !== 'off' ? { mode: S.interp, fps: +S.interpFps || 60 } : null,
        burn: enc ? this.sel.burn : null,
        stereo: !!S.stereo, channels: a ? a.channels : 2,
        // GPU decoding inside ffmpeg only pays off for heavy sources; light codecs (MPEG-2, Xvid, WMV…) decode faster on the CPU
        // and don't compete with the player for the GPU
        // (measured: 1080p HEVC 10-bit decodes faster on the CPU than through d3d11va + copy-back, so only 4K goes to the GPU)
        hwdec: S.hwdec !== false && !!v && ['hevc', 'h264', 'vp9', 'av1'].includes(v.codec_name) && (v.height || 0) >= 2000,
      };
    }

    async startMSE(at) {
      const gen = ++this.sgen;
      if (this.ctrl) { try { this.ctrl.abort(); } catch {} this.ctrl = null; }
      const v = this.video;
      let mime = this.mime();
      if (window.MediaSource && !MediaSource.isTypeSupported(mime) && this.sel.audio && this.audioCopyOK(this.sel.audio)) {
        this.forceAudioEnc = true;            // e.g. FLAC/Opus not accepted in MP4 here → AAC
        mime = this.mime();
      }
      if (!this.ms || this.msMime !== mime || this.ms.readyState === 'closed') {
        v.removeAttribute('crossorigin');
        const ms = new MediaSource();
        this.ms = ms; this.sb = null; this.msMime = mime;
        if (this.msUrl) URL.revokeObjectURL(this.msUrl);
        this.msUrl = URL.createObjectURL(ms);
        v.src = this.msUrl;
        await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
        if (gen !== this.sgen) return;
        if (this.info.duration > 0) ms.duration = this.info.duration;
        try { this.sb = ms.addSourceBuffer(mime); }
        catch (e) {
          console.warn('addSourceBuffer failed', mime, e && e.message);
          this.ms = null; this.sb = null;
          if (this.sel.audio && this.audioCopyOK(this.sel.audio)) { this.forceAudioEnc = true; return this.startMSE(at); }
          if (this.mode === 'copy' && this.sel.video) { this.failedModes.add('copy'); this.mode = 'encode'; this.emit('mode', 'encode', ['przeglądarka nie obsługuje ' + mime]); return this.startMSE(at); }
          this.emit('error', 'Nie można odtworzyć strumienia (' + mime + ').'); return;
        }
        this.sb.mode = 'segments';
        this.sb.addEventListener('error', () => console.warn('SourceBuffer error'));
      } else {
        await this.sbIdle();
        if (gen !== this.sgen) return;
        try { this.sb.abort(); } catch {}
        try { if (this.sb.buffered.length) { this.sb.remove(0, Infinity); await this.sbIdle(); } } catch (e) { console.warn('remove', e); }
        if (gen !== this.sgen) return;
      }
      try { this.sb.timestampOffset = -this.info.startTime; } catch (e) { console.warn('timestampOffset', e); }
      this.sessionStart = at;
      this.sessionT0 = performance.now();
      this.streamDone = false;
      this.ended = false;
      try { v.currentTime = at; } catch {}
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      this.pump(this.url('/stream', { s: btoa(unescape(encodeURIComponent(JSON.stringify(this.spec(at))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }), ctrl, gen, at);
      if (this.wantPlay) v.play().catch(() => {});
    }

    sbIdle() {
      const sb = this.sb;
      if (!sb || !sb.updating) return Promise.resolve();
      return new Promise(r => sb.addEventListener('updateend', r, { once: true }));
    }

    ahead() {
      const v = this.video, b = this.sb && this.sb.buffered;
      if (!b) return 0;
      const t = v.currentTime;
      for (let i = 0; i < b.length; i++) if (b.start(i) - 0.3 <= t && b.end(i) >= t) return b.end(i) - t;
      for (let i = 0; i < b.length; i++) if (b.start(i) > t) return b.end(i) - t; // data waiting just after a gap / before the seek point
      return 0;
    }

    async pump(url, ctrl, gen, at) {
      let res;
      try { res = await fetch(url, { signal: ctrl.signal }); }
      catch (e) { if (gen === this.sgen && e.name !== 'AbortError') this.emit('error', 'Strumień nie wystartował: ' + e.message); return; }
      const reader = res.body.getReader();
      let parts = [], bytes = 0, total = 0, first = true;
      this.dbg = { t0: performance.now(), bytes: 0, appends: 0, waitMs: 0, appendMs: 0, firstByte: 0 };
      const flush = async () => {
        if (!parts.length) return true;
        const buf = new Uint8Array(bytes);
        let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
        parts = []; bytes = 0;
        return this.append(buf, gen);
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (gen !== this.sgen) { reader.cancel().catch(() => {}); return; }
          if (done) break;
          if (!this.dbg.firstByte) this.dbg.firstByte = performance.now() - this.dbg.t0;
          parts.push(value); bytes += value.length; total += value.length; this.dbg.bytes = total;
          if (bytes >= (first ? 16384 : 262144) || (this.sb && !this.sb.updating && bytes > 32768)) {
            const a0 = performance.now();
            if (!await flush()) { reader.cancel().catch(() => {}); return; }
            this.dbg.appends++; this.dbg.appendMs += performance.now() - a0;
            if (first) { first = false; this.afterFirstAppend(at, gen); }
          }
          const maxAhead = +this.S().bufferAhead || 60;
          const w0 = performance.now();
          while (gen === this.sgen && this.ahead() > maxAhead) await sleep(250);
          this.dbg.waitMs += performance.now() - w0;
          if (gen !== this.sgen) { reader.cancel().catch(() => {}); return; }
        }
        if (!await flush()) return;
        if (first) this.afterFirstAppend(at, gen);
      } catch (e) {
        if (gen !== this.sgen || e.name === 'AbortError') return;
        console.warn('pump', e);
      }
      if (gen !== this.sgen) return;
      if (!total) {
        // ffmpeg produced nothing: this path does not work for this file
        return this.fallback('ffmpeg nie zwrócił danych');
      }
      this.streamDone = true;
      await this.sbIdle();
      try { if (gen === this.sgen && this.ms && this.ms.readyState === 'open' && !this.sb.updating) this.ms.endOfStream(); } catch {}
    }

    async append(buf, gen) {
      for (let attempt = 0; attempt < 400; attempt++) {
        await this.sbIdle();
        if (gen !== this.sgen || !this.sb) return false;
        try {
          if (this.ms.readyState === 'ended') { /* appendBuffer reopens it */ }
          this.sb.appendBuffer(buf);
          await this.sbIdle();
          this.trimBehind();
          return true;
        } catch (e) {
          if (e.name === 'QuotaExceededError') {
            await this.evict();
            await sleep(400);
            continue;
          }
          console.warn('appendBuffer', e);
          if (gen === this.sgen) this.fallback('błąd dołączania danych: ' + e.message);
          return false;
        }
      }
      return false;
    }

    trimBehind() {
      const sb = this.sb, t = this.video.currentTime;
      if (!sb || sb.updating || !sb.buffered.length) return;
      const start = sb.buffered.start(0);
      if (t - start > 90) { try { sb.remove(start, t - 30); } catch {} }
    }

    async evict() {
      const sb = this.sb, t = this.video.currentTime;
      if (!sb) return;
      await this.sbIdle();
      try {
        const b = sb.buffered;
        if (b.length && t - b.start(0) > 4) { sb.remove(b.start(0), t - 3); await this.sbIdle(); }
      } catch {}
    }

    afterFirstAppend(at, gen) {
      if (gen !== this.sgen) return;
      const v = this.video, b = this.sb && this.sb.buffered;
      if (b && b.length) {
        const s = b.start(0);
        if (s > at && s - at < 3) { try { v.currentTime = s + 0.001; } catch {} }
      }
      if (this.wantPlay && v.paused) v.play().catch(() => {});
    }

    jumpGap() {
      if (!this.sb || !this.sb.buffered) return;
      const v = this.video, b = this.sb.buffered, t = v.currentTime;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) > t + 0.05) return;
      for (let i = 0; i < b.length; i++) {
        const s = b.start(i);
        if (s > t && s - t < 2.5) { v.currentTime = s + 0.01; return; }
      }
      if (this.streamDone && b.length && t >= b.end(b.length - 1) - 0.25 && this.info.duration && t > this.info.duration - 3) this.emit('end-of-stream');
    }

    // live conversion that can't keep up (playback keeps stalling with an empty buffer) → lower the conversion resolution
    noteStall() {
      if (this.mode !== 'encode' || !this.sel.video || this.video.seeking || this.streamDone) return;
      const now = performance.now();
      if (!this.sessionT0 || now - this.sessionT0 < 6000) return;          // start-up and seeks don't count
      if (this.ahead() > 0.5) return;
      this.stalls = (this.stalls || []).filter(t => now - t < 30000);
      this.stalls.push(now);
      if (this.stalls.length < 2) return;
      const h = Math.min(this.sel.video.height || 0, this.autoMaxHeight || 1e9, +this.S().maxHeight || 1e9);
      const next = [1440, 1080, 720, 540, 360].find(x => x < h - 8);
      if (!next) return;
      this.stalls = [];
      this.autoMaxHeight = next;
      this.emit('downscale', next);
      this.startMSE(this.currentTime());
    }

    fallback(why) {
      const order = ['direct', 'copy', 'encode'];
      this.failedModes.add(this.mode);
      const next = order.find((m, i) => i > order.indexOf(this.mode) && !this.failedModes.has(m) && (m !== 'copy' || (this.sel.video ? COPY_VIDEO.includes(this.sel.video.codec_name) : true)));
      console.warn('fallback from', this.mode, 'because', why, '→', next);
      if (!next || (next === 'encode' && !this.sel.video && this.mode === 'copy')) {
        if (!this.sel.video && this.mode === 'copy' && !this.failedModes.has('encode-audio')) { this.failedModes.add('encode-audio'); }
        const known = !!(this.sel.video || this.sel.audio);
        this.emit('error', known ? 'Nie udało się odtworzyć: ' + why : 'Pod tym adresem nie ma pliku wideo ani dźwięku, który da się odtworzyć.', { retry: known });
        return;
      }
      const t = this.currentTime() || 0;
      this.ms = null; this.sb = null;
      this.start(t, next);
    }

    onVideoError() {
      const err = this.video.error;
      if (!err || !this.mode) return;
      if (this.video.src === '' || this.video.getAttribute('src') === null) return;
      console.warn('video error', this.mode, err.code, err.message);
      this.fallback(`kod ${err.code}${err.message ? ' — ' + err.message : ''}`);
    }

    checkDecoded() {
      // direct playback that decodes no picture (unsupported profile) → try the next path
      if (this.mode === 'direct' && this.sel.video && !this.video.videoWidth) setTimeout(() => {
        if (this.mode === 'direct' && !this.video.videoWidth) this.fallback('brak obrazu');
      }, 400);
    }

    // ---------- control ----------
    currentTime() { return this.video.currentTime || 0; }
    duration() { return (this.info && this.info.duration) || (isFinite(this.video.duration) ? this.video.duration : 0); }
    play() { this.wantPlay = true; if (this.ended && this.mode) { this.seek(0); } return this.video.play().catch(() => {}); }
    pause() { this.wantPlay = false; this.video.pause(); }
    seek(t, exact) {
      if (!this.mode) return;
      const d = this.duration();
      t = Math.max(0, d ? Math.min(t, d - 0.05) : t);
      this.ended = false;
      if (this.mode === 'direct') {
        if (!exact && 'fastSeek' in this.video && this.S().fastSeek) this.video.fastSeek(t);
        else this.video.currentTime = t;
        return;
      }
      const b = this.sb && this.sb.buffered;
      if (b) for (let i = 0; i < b.length; i++) {
        if (t >= b.start(i) && (t <= b.end(i) - 0.3 || (this.streamDone && t <= b.end(i)))) { this.video.currentTime = t; return; }
      }
      this.startMSE(t);
    }
    restart() {
      if (!this.mode || !this.info) return;
      const t = this.currentTime();
      if (this.mode === 'direct') return;
      this.startMSE(t);
    }
    // settings that change ffmpeg's job (encoder, quality, deinterlacing…) or the path itself
    replan() {
      if (!this.info || !this.mode || this.loading) return;
      const p = this.plan();
      const t = this.currentTime();
      if (p.mode !== this.mode) { this.ms = null; this.sb = null; this.failedModes = new Set(); this.start(t, null); }
      else if (p.mode !== 'direct') { this.reasons = p.reasons; this.emit('mode', p.mode, p.reasons); this.startMSE(t); }
    }
    setAudio(stream) {
      this.sel.audio = stream;
      if (!this.mode) return;
      if (this.mode === 'direct') {
        if (this.video.audioTracks && this.video.audioTracks.length === this.info.audio.length) { this.applyDirectAudio(); return; }
        this.ms = null; this.sb = null;
        return this.start(this.currentTime(), null);
      }
      this.ms = null; this.sb = null;      // codec string may change
      this.start(this.currentTime(), null);
    }
    setBurn(sub) {
      this.sel.burn = sub ? { index: sub.index, rel: sub.rel, bitmap: !!sub.bitmap } : null;
      if (!this.mode) return;
      this.ms = null; this.sb = null;
      this.failedModes = new Set();
      this.start(this.currentTime(), null);
    }
    stop() { this.teardown(); this.info = null; this.item = null; this.emit('stopped'); }
    bufferedRanges() {
      const b = this.sb ? this.sb.buffered : this.video.buffered;
      const out = [];
      try { for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]); } catch {}
      return out;
    }
  }

  function pickByLang(list, pref) {
    if (!list.length) return null;
    const langs = String(pref || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
    for (const l of langs) {
      const m = list.find(s => { const t = (s.tags && (s.tags.language || s.tags.LANGUAGE) || '').toLowerCase(); return t === l || t.startsWith(l) || (l.length === 2 && K.langName(t) === K.langName(l)); });
      if (m) return m;
    }
    return list.find(s => s.disposition && s.disposition.default) || list[0];
  }
  K.pickByLang = pickByLang;
  K.Engine = Engine;
})();
