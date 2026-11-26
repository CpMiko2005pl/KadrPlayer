// Kadr Player — the media side of the main process:
//  • ffprobe (what is inside a file), ffmpeg (remux / convert any format to fragmented MP4 for the player)
//  • a tiny HTTP server on 127.0.0.1 that the page plays from:
//      /file   the file itself with Range support (direct playback) — or a proxied http(s) address
//      /stream fragmented MP4 made by ffmpeg on the fly (formats Chromium can't open), read by MediaSource
//      /thumb  one frame for the seek-bar preview,  /cover  album art of music files
//  • subtitles: embedded text tracks → SRT, external files decoded from UTF-8 / UTF-16 / Windows-1250
//  • which hardware H.264 encoders work on this PC, black-bar detection
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.wav': 'audio/wav', '.weba': 'audio/webm',
};
const SUB_EXT = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.txt', '.mpl', '.smi'];

class Media {
  constructor({ appDir, resourcesDir, packaged, log }) {
    this.log = log || (() => {});
    const dirs = packaged ? [path.join(resourcesDir, 'ffmpeg')] : [path.join(appDir, 'vendor', 'ffmpeg')];
    const pick = name => {
      for (const d of dirs) { const p = path.join(d, name + '.exe'); if (fs.existsSync(p)) return p; }
      return name;                                    // fall back to PATH (dev machines)
    };
    this.ffmpeg = pick('ffmpeg');
    this.ffprobe = pick('ffprobe');
    this.token = crypto.randomBytes(16).toString('hex');
    this.procs = new Set();
    this.subCache = new Map();
  }

  // ---------- HTTP server ----------
  start() {
    return new Promise((ok, fail) => {
      this.server = http.createServer((req, res) => this.handle(req, res).catch(e => {
        this.log('http error', e && e.stack || e);
        if (!res.headersSent) { res.writeHead(500, this.cors()); }
        res.end();
      }));
      this.server.on('error', fail);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.base = `http://127.0.0.1:${this.port}`;
        ok(this.base);
      });
    });
  }

  stop() {
    for (const p of this.procs) { try { p.kill('SIGKILL'); } catch {} }
    this.procs.clear();
    try { this.server && this.server.close(); } catch {}
  }

  cors(extra) {
    return Object.assign({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges', 'Cache-Control': 'no-store' }, extra || {});
  }

  async handle(req, res) {
    const u = new URL(req.url, this.base);
    if (req.method === 'OPTIONS') { res.writeHead(204, this.cors()); return res.end(); }
    if (u.searchParams.get('k') !== this.token) { res.writeHead(403, this.cors()); return res.end(); }
    switch (u.pathname) {
      case '/file': return u.searchParams.get('u') ? this.serveRemote(req, res, u.searchParams.get('u'), 0) : this.serveFile(req, res, u.searchParams.get('p'));
      case '/stream': return this.serveStream(req, res, JSON.parse(Buffer.from(u.searchParams.get('s'), 'base64url').toString('utf8')));
      case '/thumb': return this.serveThumb(req, res, u.searchParams.get('p'), +u.searchParams.get('t') || 0, +u.searchParams.get('w') || 192);
      case '/cover': return this.serveCover(req, res, u.searchParams.get('p'));
      default: res.writeHead(404, this.cors()); return res.end();
    }
  }

  serveFile(req, res, file) {
    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404, this.cors()); return res.end(); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (range) {
      if (range[1] === '' && range[2] !== '') { start = Math.max(0, st.size - +range[2]); }
      else { start = +range[1] || 0; if (range[2] !== '') end = Math.min(end, +range[2]); }
      if (start > end || start >= st.size) { res.writeHead(416, this.cors({ 'Content-Range': `bytes */${st.size}` })); return res.end(); }
      code = 206;
    }
    const head = this.cors({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    if (code === 206) head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(code, head);
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 });
    s.on('error', () => res.destroy());
    res.on('close', () => s.destroy());
    s.pipe(res);
  }

  // http(s) addresses go through us so the page gets CORS headers (WebGL + Web Audio need them)
  serveRemote(req, res, address, hops) {
    let target;
    try { target = new URL(address); } catch { res.writeHead(400, this.cors()); return res.end(); }
    if (!/^https?:$/.test(target.protocol)) { res.writeHead(400, this.cors()); return res.end(); }
    const lib = target.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'KadrPlayer/1.0' };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = lib.get(target, { headers }, r => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 6) {
        r.resume();
        return this.serveRemote(req, res, new URL(r.headers.location, target).toString(), hops + 1);
      }
      const keep = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers[h]) keep[h] = r.headers[h];
      res.writeHead(r.statusCode, this.cors(keep));
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, this.cors()); res.end(); });
    res.on('close', () => up.destroy());
  }

  // remote files go to ffmpeg through our own proxy: Node connects where ffmpeg's network code times out
  // (seen with archive.org), and redirects/ranges are handled there; playlists (.m3u8/.mpd) need their real address
  ffInput(input) {
    if (!/^https?:/i.test(input) || /\.(m3u8|mpd)(\?|$)/i.test(input) || !this.base) return input;
    return `${this.base}/file?k=${this.token}&u=${encodeURIComponent(input)}`;
  }

  run(args, { onSpawn } = {}) {
    const p = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.procs.add(p);
    p.on('exit', () => this.procs.delete(p));
    p.on('error', e => { this.log('ffmpeg spawn error', e.message); this.procs.delete(p); });
    if (onSpawn) onSpawn(p);
    return p;
  }

  // ---------- on-the-fly conversion ----------
  // spec (built by the page): { input, ss, vi, ai, video:'copy'|'encode'|'none', audio:'copy'|'encode'|'none',
  //   encoder, quality:'max'|'balanced'|'fast', maxHeight, deint, tonemap, interp:{mode:'blend'|'mci', fps},
  //   burn:{ index, rel, bitmap }, stereo, hwdec, fps, height, channels }
  streamArgs(s) {
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const remote = /^https?:/i.test(s.input);
    if (remote) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (s.video === 'encode' && s.hwdec) a.push('-hwaccel', 'd3d11va');
    if (s.ss > 0) a.push('-ss', s.ss.toFixed(3));
    a.push('-i', this.ffInput(s.input));

    const maps = [];
    let vf = [];
    if (s.video === 'encode') {
      if (s.deint) vf.push('bwdif=mode=send_field:deint=interlaced');
      if (s.tonemap) vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
      if (s.maxHeight && s.height > s.maxHeight) vf.push(`scale=-2:${s.maxHeight}:flags=lanczos`);
      if (s.interp && s.interp.fps) {
        vf.push(s.interp.mode === 'mci'
          ? `minterpolate=fps=${s.interp.fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
          : `framerate=fps=${s.interp.fps}`);
      }
      vf.push(s.encoder === 'h264_qsv' ? 'format=nv12' : 'format=yuv420p');
    }

    if (s.video !== 'none' && s.vi >= 0) {
      if (s.video === 'encode' && s.burn && s.burn.bitmap) {
        a.push('-filter_complex', `[0:${s.vi}][0:${s.burn.index}]overlay=eof_action=pass:repeatlast=0${vf.length ? ',' + vf.join(',') : ''}[kv]`);
        maps.push('-map', '[kv]');
      } else {
        if (s.video === 'encode' && s.burn) vf.unshift(`subtitles=filename=${escFilterPath(s.input)}:si=${s.burn.rel}`);
        maps.push('-map', `0:${s.vi}`);
        if (vf.length) a.push('-vf', vf.join(','));
      }
    }
    if (s.audio !== 'none' && s.ai >= 0) maps.push('-map', `0:${s.ai}`);
    a.push(...maps, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');

    if (s.video === 'copy') a.push('-c:v', 'copy', ...(s.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []));
    else if (s.video === 'encode') a.push(...encoderArgs(s));
    if (s.audio === 'copy') a.push('-c:a', 'copy');
    else if (s.audio === 'encode') {
      const ch = s.stereo ? 2 : Math.min(s.channels || 2, 8);
      a.push('-c:a', 'aac', '-b:a', ch > 2 ? '448k' : '256k', '-ac', String(ch), '-af', 'aresample=async=1000');
    }
    // -copyts + frag_discont + negative_cts_offsets: fragments keep the file's own timestamps (tfdt), so after a seek
    // the page appends them at their real place on the timeline (otherwise every restart would begin at 0)
    a.push('-copyts', '-max_muxing_queue_size', '4096', '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+frag_discont+negative_cts_offsets', '-frag_duration', '1000000', 'pipe:1');
    return a;
  }

  serveStream(req, res, spec) {
    const args = this.streamArgs(spec);
    this.log('stream', args.join(' '));
    res.writeHead(200, this.cors({ 'Content-Type': 'video/mp4' }));
    let err = '';
    const p = this.run(args);
    p.stdout.pipe(res);
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('exit', code => {
      if (code && err) this.log('ffmpeg exit', code, err.trim());
      res.end();
    });
    res.on('close', () => { try { p.kill('SIGKILL'); } catch {} });
  }

  serveThumb(req, res, input, t, w) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-ss', String(Math.max(0, t)), '-i', input,
      '-map', '0:V:0?', '-frames:v', '1', '-vf', `scale=${w}:-2:flags=bilinear`, '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2', 'pipe:1'];
    this.pipeImage(req, res, args);
  }

  serveCover(req, res, input) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-an', '-map', '0:v:0?', '-frames:v', '1',
      '-vf', 'scale=min(800\\,iw):-2', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2', 'pipe:1'];
    this.pipeImage(req, res, args);
  }

  pipeImage(req, res, args) {
    const chunks = [];
    const p = this.run(args);
    p.stdout.on('data', d => chunks.push(d));
    p.on('exit', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) { res.writeHead(404, this.cors()); return res.end(); }
      res.writeHead(200, this.cors({ 'Content-Type': 'image/jpeg', 'Content-Length': buf.length }));
      res.end(buf);
    });
    res.on('close', () => { try { p.kill('SIGKILL'); } catch {} });
  }

  // ---------- a web page instead of a file: look for a direct video link in its HTML ----------
  // (og:video meta, <video>/<source>, JSON-LD contentUrl, links to .mp4/.webm/.m3u8/… files)
  fetchText(address, maxBytes = 3 << 20, hops = 0) {
    return new Promise((ok, fail) => {
      let target;
      try { target = new URL(address); } catch (e) { return fail(e); }
      const lib = target.protocol === 'https:' ? https : http;
      const req = lib.get(target, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) KadrPlayer/1.0', Accept: 'text/html,*/*' }, timeout: 25000 }, r => {
        if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 6) {
          r.resume();
          return this.fetchText(new URL(r.headers.location, target).toString(), maxBytes, hops + 1).then(ok, fail);
        }
        const chunks = []; let n = 0;
        r.on('data', d => { n += d.length; chunks.push(d); if (n > maxBytes) r.destroy(); });
        r.on('close', () => ok({ url: target.toString(), status: r.statusCode, type: r.headers['content-type'] || '', text: Buffer.concat(chunks).toString('utf8') }));
        r.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', fail);
    });
  }

  async findInPage(address) {
    const page = await this.fetchText(address);
    const html = page.text;
    const base = page.url;
    const dec = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\\\//g, '/');
    const abs = s => { try { return new URL(dec(s.trim()), base).toString(); } catch { return null; } };
    const VID = /\.(mp4|m4v|webm|mkv|mov|ogv|m3u8|mpd|mp3|m4a|ogg|opus|flac)(\?[^"'\s<>]*)?$/i;
    const found = [];
    const add = (u, why) => { const a = u && abs(u); if (a && /^https?:/i.test(a) && !found.some(f => f.url === a)) found.push({ url: a, why }); };
    for (const m of html.matchAll(/<meta[^>]+(?:property|name)\s*=\s*["'](og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*>/gi)) {
      const c = /content\s*=\s*["']([^"']+)["']/i.exec(m[0]); if (c) add(c[1], 'meta');
    }
    for (const m of html.matchAll(/<(?:video|source|audio)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1], 'video');
    for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gi)) add(m[1], 'json-ld');
    for (const m of html.matchAll(/(?:href|src|data-src|file)\s*[=:]\s*["']([^"']+)["']/gi)) if (VID.test(dec(m[1]))) add(m[1], 'link');
    for (const m of html.matchAll(/https?:(?:\\?\/){2}[^"'\s<>]+/gi)) if (VID.test(dec(m[0]))) add(m[0], 'url');
    // prefer streams and the biggest-looking video files over previews/audio
    const score = f => (/\.m3u8|\.mpd/i.test(f.url) ? 50 : /\.(mp4|webm|mkv|mov|m4v)/i.test(f.url) ? 40 : 10) + ({ meta: 8, 'json-ld': 6, video: 5, link: 2, url: 0 }[f.why] || 0)
      - (/(preview|trailer|thumb|sample|teaser)/i.test(f.url) ? 30 : 0) + (/(1080|720|hd|high|orig)/i.test(f.url) ? 3 : 0);
    found.sort((a, b) => score(b) - score(a));
    const title = (/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html) || /<title[^>]*>([^<]+)<\/title>/i.exec(html) || [])[1] || '';
    return { title: dec(title).trim(), links: found.slice(0, 20).map(f => f.url) };
  }

  // ---------- probing ----------
  probe(input) {
    return new Promise((ok, fail) => {
      const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters'];
      if (/^https?:/i.test(input)) args.push('-rw_timeout', '15000000');
      execFile(this.ffprobe, [...args, this.ffInput(input)], { windowsHide: true, maxBuffer: 64 << 20, timeout: 45000 }, (e, out, err) => {
        if (e) return fail(new Error((err || e.message || '').toString().trim().split('\n').pop().replace(/http:\/\/127\.0\.0\.1:\d+\/file\?\S+/, input) || 'ffprobe nie odczytał pliku'));
        try { ok(JSON.parse(out)); } catch (x) { fail(x); }
      });
    });
  }

  version() {
    return new Promise(ok => execFile(this.ffmpeg, ['-hide_banner', '-version'], { windowsHide: true, timeout: 10000 }, (e, out) => {
      ok(e ? null : (/ffmpeg version (\S+)/.exec(out) || [])[1] || '?');
    }));
  }

  // which H.264 encoders really work here (a driver can list nvenc/qsv/amf without the hardware)
  async encoders() {
    const test = enc => new Promise(ok => {
      const extra = enc === 'h264_qsv' ? ['-vf', 'format=nv12'] : ['-pix_fmt', 'yuv420p'];
      execFile(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=25', '-frames:v', '4', ...extra, '-c:v', enc, '-f', 'null', '-'],
        { windowsHide: true, timeout: 15000 }, e => ok(!e));
    });
    const out = [];
    for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) if (await test(enc)) out.push(enc);
    out.push('libx264');
    return out;
  }

  // black bars: sample a few spots, keep the crop that removes the least (safe for bright scenes)
  async cropdetect(input, duration) {
    const spots = duration > 60 ? [0.2, 0.45, 0.7].map(f => duration * f) : [Math.min(5, duration / 3)];
    const results = [];
    for (const t of spots) {
      // (no -skip_frame nokey: with sparse keyframes it yields 0–1 frames, and cropdetect needs skip=0 to report the first ones)
      const out = await new Promise(ok => execFile(this.ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(t), '-i', input, '-map', '0:V:0', '-an', '-sn', '-frames:v', '10', '-vf', 'cropdetect=limit=24:round=2:reset=0:skip=0', '-f', 'null', '-'],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 }, (e, so, se) => ok(String(se || ''))));
      const all = [...out.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
      if (all.length) { const m = all[all.length - 1]; results.push({ w: +m[1], h: +m[2], x: +m[3], y: +m[4] }); }
    }
    if (!results.length) return null;
    return results.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  }

  // ---------- subtitles ----------
  embeddedSubtitle(input, index) {
    const key = input + '#' + index;
    if (this.subCache.has(key)) return this.subCache.get(key);
    const job = new Promise((ok, fail) => {
      const chunks = [];
      let err = '';
      const p = this.run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', `0:${index}`, '-c:s', 'srt', '-f', 'srt', 'pipe:1']);
      p.stdout.on('data', d => chunks.push(d));
      p.stderr.on('data', d => { err += d; });
      p.on('exit', code => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (code && !text) { this.subCache.delete(key); fail(new Error(err.trim().split('\n').pop() || 'nie udało się wczytać napisów')); }
        else ok(text);
      });
    });
    this.subCache.set(key, job);
    return job;
  }

  readText(file) {
    const buf = fs.readFileSync(file);
    return decodeText(buf);
  }

  findSubtitles(videoPath) {
    if (!videoPath || /^https?:/i.test(videoPath)) return [];
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    const scan = (d, prefixOnly) => {
      let list; try { list = fs.readdirSync(d); } catch { return; }
      for (const n of list) {
        const ext = path.extname(n).toLowerCase();
        if (!SUB_EXT.includes(ext)) continue;
        const stem = n.slice(0, -ext.length).toLowerCase();
        if (prefixOnly && !(stem === base || stem.startsWith(base + '.') || stem.startsWith(base + '_') || stem.startsWith(base + ' ') || stem.startsWith(base + '-'))) continue;
        if (ext === '.txt' && !prefixOnly) continue;
        out.push(path.join(d, n));
      }
    };
    scan(dir, true);
    for (const n of names) if (/^(subs?|napisy|subtitles)$/i.test(n)) scan(path.join(dir, n), false);
    return out;
  }
}

function encoderArgs(s) {
  const q = s.quality || 'balanced';
  const fps = s.interp && s.interp.fps ? s.interp.fps : (s.fps || 25) * (s.deint ? 2 : 1);
  const gop = String(Math.max(12, Math.round(fps * 2)));
  switch (s.encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', { max: 'p5', balanced: 'p4', fast: 'p2' }[q], '-tune', 'hq', '-rc', 'vbr', '-cq', { max: '17', balanced: '20', fast: '24' }[q], '-b:v', '0', '-g', gop, '-bf', '2'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', { max: 'medium', balanced: 'faster', fast: 'veryfast' }[q], '-global_quality', { max: '17', balanced: '21', fast: '25' }[q], '-look_ahead', '0', '-g', gop];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', { max: 'quality', balanced: 'balanced', fast: 'speed' }[q], '-rc', 'cqp', '-qp_i', { max: '17', balanced: '20', fast: '24' }[q], '-qp_p', { max: '19', balanced: '22', fast: '26' }[q], '-g', gop];
    default:
      return ['-c:v', 'libx264', '-preset', { max: 'veryfast', balanced: 'superfast', fast: 'ultrafast' }[q], '-crf', { max: '16', balanced: '19', fast: '23' }[q],
        '-x264-params', 'rc-lookahead=10', '-g', gop, '-profile:v', 'high'];
  }
}

// a path inside a filter graph: escaped once for the option parser and once for the graph parser
function escFilterPath(p) {
  const opt = p.replace(/\\/g, '/').replace(/[:'\\]/g, m => '\\' + m);
  return opt.replace(/[\\'\[\],;]/g, m => '\\' + m);
}

// subtitles in Poland come in UTF-8, UTF-16 or Windows-1250 (sometimes ISO-8859-2)
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.slice(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.slice(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  // ISO-8859-2 puts ą/ś/ź at 0xB1/0xB6/0xBC where Windows-1250 has ±/¶/Ľ — pick the one with more Polish letters
  const w = new TextDecoder('windows-1250').decode(buf);
  let iso = null;
  try { iso = new TextDecoder('iso-8859-2').decode(buf); } catch {}
  if (!iso) return w;
  const score = s => (s.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
  return score(iso) > score(w) ? iso : w;
}

module.exports = { Media, decodeText, escFilterPath, SUB_EXT };
