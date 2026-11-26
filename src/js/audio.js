// Kadr Player — sound chain on Web Audio:
// video → delay (A/V offset + smooth-motion latency) → preamp → 10-band EQ → dialogue boost → mono → compressor → volume → analyser → output
window.K = window.K || {};
(() => {
  const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  K.EQ_BANDS = BANDS;
  K.EQ_PRESETS = {
    flat: { name: 'Płaski', g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    bass: { name: 'Mocny bas', g: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    voice: { name: 'Dialogi / wokal', g: [-3, -2, -1, 0, 2, 4, 4, 3, 1, 0] },
    movie: { name: 'Kino', g: [4, 3, 1, 0, -1, 0, 1, 2, 3, 3] },
    rock: { name: 'Rock', g: [4, 3, 2, 0, -1, -1, 1, 2, 3, 4] },
    pop: { name: 'Pop', g: [-1, 0, 2, 3, 4, 3, 1, 0, -1, -1] },
    jazz: { name: 'Jazz', g: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
    classic: { name: 'Klasyczna', g: [3, 2, 1, 0, 0, 0, -1, -1, 1, 3] },
    electro: { name: 'Elektroniczna', g: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
    laptop: { name: 'Głośniki laptopa', g: [-8, -6, -2, 1, 2, 2, 3, 3, 2, 1] },
    headphones: { name: 'Słuchawki', g: [3, 2, 0, -1, -1, 0, 1, 2, 3, 2] },
    treble: { name: 'Jasne soprany', g: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  };

  class AudioChain {
    constructor(media) {
      this.media = media;
      this.ctx = null;
      this.opts = { volume: 1, muted: false, eqOn: false, eq: BANDS.map(() => 0), preamp: 0, normalize: false, dialog: false, mono: false, delayMs: 0, extraDelay: 0 };
    }
    ensure() {
      if (this.ctx) return true;
      try {
        const ctx = new AudioContext({ latencyHint: 'playback' });
        this.ctx = ctx;
        this.src = ctx.createMediaElementSource(this.media);
        this.delay = ctx.createDelay(5);
        this.pre = ctx.createGain();
        this.eq = BANDS.map((f, i) => {
          const b = ctx.createBiquadFilter();
          b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
          b.frequency.value = f; b.Q.value = 1.1;
          return b;
        });
        this.dlg1 = ctx.createBiquadFilter(); this.dlg1.type = 'peaking'; this.dlg1.frequency.value = 2600; this.dlg1.Q.value = 0.8; this.dlg1.gain.value = 6;
        this.dlg2 = ctx.createBiquadFilter(); this.dlg2.type = 'lowshelf'; this.dlg2.frequency.value = 160; this.dlg2.gain.value = -5;
        this.monoIn = ctx.createGain(); this.monoIn.channelCount = 1; this.monoIn.channelCountMode = 'explicit'; this.monoIn.channelInterpretation = 'speakers';
        this.comp = ctx.createDynamicsCompressor();
        this.comp.threshold.value = -28; this.comp.knee.value = 24; this.comp.ratio.value = 4; this.comp.attack.value = 0.006; this.comp.release.value = 0.28;
        this.makeup = ctx.createGain(); this.makeup.gain.value = 1.7;
        this.vol = ctx.createGain();
        this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.78;
        this.rewire();
        this.apply();
        if (this.sinkId) this.setSink(this.sinkId);
        return true;
      } catch (e) {
        console.warn('Web Audio unavailable', e);
        this.ctx = null;
        return false;
      }
    }
    resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
    rewire() {
      const o = this.opts;
      const nodes = [this.src, this.delay, this.pre];
      if (o.eqOn) nodes.push(...this.eq);
      if (o.dialog) nodes.push(this.dlg2, this.dlg1);
      if (o.mono) nodes.push(this.monoIn);
      if (o.normalize) nodes.push(this.comp, this.makeup);
      nodes.push(this.vol, this.analyser, this.ctx.destination);
      for (const n of [this.src, this.delay, this.pre, ...this.eq, this.dlg1, this.dlg2, this.monoIn, this.comp, this.makeup, this.vol, this.analyser]) { try { n.disconnect(); } catch {} }
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    }
    apply() {
      if (!this.ctx) { this.media.volume = Math.min(1, this.opts.volume); this.media.muted = this.opts.muted; return; }
      const o = this.opts, t = this.ctx.currentTime;
      this.media.volume = 1; this.media.muted = false;
      this.vol.gain.setTargetAtTime(o.muted ? 0 : o.volume, t, 0.015);
      this.pre.gain.value = Math.pow(10, (o.eqOn ? o.preamp : 0) / 20);
      this.eq.forEach((b, i) => { b.gain.value = o.eq[i] || 0; });
      this.delay.delayTime.setTargetAtTime(Math.max(0, Math.min(4.9, (o.delayMs || 0) / 1000 + (o.extraDelay || 0))), t, 0.05);
    }
    set(p) {
      const before = { eqOn: this.opts.eqOn, dialog: this.opts.dialog, mono: this.opts.mono, normalize: this.opts.normalize };
      Object.assign(this.opts, p);
      if (this.ctx && Object.keys(before).some(k => before[k] !== this.opts[k])) this.rewire();
      this.apply();
    }
    async devices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        return list.filter(d => d.kind === 'audiooutput').map(d => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'Domyślne urządzenie' : 'Urządzenie ' + d.deviceId.slice(0, 6)) }));
      } catch { return []; }
    }
    async setSink(id) {
      this.sinkId = id;
      const target = id && id !== 'default' ? id : '';
      try {
        if (this.ctx && this.ctx.setSinkId) await this.ctx.setSinkId(target);
        else if (this.media.setSinkId) await this.media.setSinkId(target);
        return true;
      } catch (e) { console.warn('setSinkId', e); return false; }
    }
    spectrum(out) {
      if (!this.analyser) return null;
      if (!out || out.length !== this.analyser.frequencyBinCount) out = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(out);
      return out;
    }
  }
  K.AudioChain = AudioChain;
})();
