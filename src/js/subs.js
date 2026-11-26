// Kadr Player — subtitles: parsers (SRT, WebVTT, ASS/SSA, MicroDVD, MPL2, TMPlayer, SAMI) and a safe renderer.
// Cue text keeps a tiny markup subset (<i>, <b>, <u>, <font color>) that is rebuilt with DOM nodes, never innerHTML.
window.K = window.K || {};
(() => {
  const toSec = (h, m, s, ms) => (+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0) + (+(String(ms || 0).padEnd(3, '0').slice(0, 3)) / 1000);

  function parseSRT(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
    const re = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
    for (const b of blocks) {
      const lines = b.split('\n');
      const i = lines.findIndex(l => re.test(l));
      if (i < 0) continue;
      const m = re.exec(lines[i]);
      const body = lines.slice(i + 1).join('\n').trim();
      if (!body) continue;
      cues.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: body.replace(/\{\\an8\}/g, () => '').replace(/\{[^}]*\}/g, ''), top: /\{\\an[789]\}/.test(body) });
    }
    return cues;
  }

  function parseVTT(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
    const re = /(?:(\d+):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})([^\n]*)/;
    for (const b of blocks) {
      const lines = b.split('\n');
      const i = lines.findIndex(l => re.test(l));
      if (i < 0) continue;
      const m = re.exec(lines[i]);
      const body = lines.slice(i + 1).join('\n').replace(/<\/?c[^>]*>/g, '').replace(/<\d+:\d+[^>]*>/g, '').replace(/<v [^>]*>/g, '').replace(/<\/v>/g, '').trim();
      if (!body) continue;
      cues.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: body, top: /line:\s*(\d+)%/.test(m[9]) && +/line:\s*(\d+)%/.exec(m[9])[1] < 50 });
    }
    return cues;
  }

  function assText(raw) {
    let t = raw.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
    let out = '', italic = false, bold = false, top = false;
    t = t.replace(/\{([^}]*)\}/g, (all, tags) => {
      let s = '';
      if (/\\an[789]/.test(tags) || /\\a(5|6|7|9|10|11)\b/.test(tags)) top = true;
      const it = /\\i([01])/.exec(tags);
      if (it) { if (it[1] === '1' && !italic) { s += '<i>'; italic = true; } else if (it[1] === '0' && italic) { s += '</i>'; italic = false; } }
      const bo = /\\b(\d+)/.exec(tags);
      if (bo) { const on = bo[1] !== '0' && bo[1] !== '400'; if (on && !bold) { s += '<b>'; bold = true; } else if (!on && bold) { s += '</b>'; bold = false; } }
      return s;
    });
    out = t + (bold ? '</b>' : '') + (italic ? '</i>' : '');
    return { text: out.trim(), top };
  }

  function parseASS(text) {
    const cues = [];
    let fmt = null, inEvents = false;
    const styles = {};
    let styleFmt = null;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      const l = line.trim();
      if (/^\[/.test(l)) { inEvents = /^\[events\]/i.test(l); continue; }
      if (/^format:/i.test(l)) {
        const f = l.slice(7).split(',').map(s => s.trim().toLowerCase());
        if (inEvents) fmt = f; else styleFmt = f;
        continue;
      }
      if (/^style:/i.test(l) && styleFmt) {
        const p = l.slice(6).split(',');
        const name = (p[styleFmt.indexOf('name')] || '').trim();
        const align = +(p[styleFmt.indexOf('alignment')] || 2);
        styles[name] = { top: align >= 7, italic: (p[styleFmt.indexOf('italic')] || '0').trim() === '-1' };
        continue;
      }
      if (!inEvents || !/^dialogue:/i.test(l)) continue;
      const f = fmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = l.slice(9).split(',');
      const head = parts.slice(0, f.length - 1).map(s => s.trim());
      const body = parts.slice(f.length - 1).join(',');
      const tm = s => { const m = /(\d+):(\d+):(\d+)[.:](\d+)/.exec(s || ''); return m ? toSec(m[1], m[2], m[3], m[4].padEnd(2, '0') + '0') : 0; };
      const start = tm(head[f.indexOf('start')]), end = tm(head[f.indexOf('end')]);
      if (/\\p[1-9]/.test(body)) continue;                         // vector drawings
      const st = styles[head[f.indexOf('style')]] || {};
      const r = assText(body);
      if (!r.text) continue;
      cues.push({ start, end, text: st.italic && !/^<i>/.test(r.text) ? `<i>${r.text}</i>` : r.text, top: r.top || st.top });
    }
    return cues;
  }

  function parseMicroDVD(text, fps) {
    const cues = [];
    let rate = fps || 23.976;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      const m = /^\{(\d+)\}\{(\d*)\}(.*)$/.exec(line.trim());
      if (!m) continue;
      if ((m[1] === '1' || m[1] === '0') && (m[2] === '1' || m[2] === '0') && /^\d+([.,]\d+)?$/.test(m[3].trim())) { rate = parseFloat(m[3].replace(',', '.')) || rate; continue; }
      const start = +m[1] / rate;
      const end = m[2] ? +m[2] / rate : start + 3;
      cues.push({ start, end, text: mdvdText(m[3]), top: false });
    }
    return cues;
  }
  function mdvdText(s) {
    return s.split('|').map(part => {
      let t = part, it = false, bo = false;
      t = t.replace(/\{([yY]):([^}]*)\}/g, (a, y, v) => { if (/i/i.test(v)) it = true; if (/b/i.test(v)) bo = true; return ''; }).replace(/\{[^}]*\}/g, '');
      if (t.startsWith('/')) { it = true; t = t.slice(1); }
      if (bo) t = `<b>${t}</b>`;
      if (it) t = `<i>${t}</i>`;
      return t;
    }).join('\n');
  }

  function parseMPL2(text) {
    const cues = [];
    for (const line of text.replace(/\r/g, '').split('\n')) {
      const m = /^\[(\d+)\]\[(\d*)\](.*)$/.exec(line.trim());
      if (!m) continue;
      const start = +m[1] / 10, end = m[2] ? +m[2] / 10 : start + 3;
      cues.push({ start, end, text: m[3].split('|').map(p => (p.startsWith('/') ? `<i>${p.slice(1)}</i>` : p)).join('\n'), top: false });
    }
    return cues;
  }

  function parseTMP(text) {
    const raw = [];
    for (const line of text.replace(/\r/g, '').split('\n')) {
      const m = /^(\d{1,2}):(\d{2}):(\d{2})[:=](.*)$/.exec(line.trim());
      if (m) raw.push({ start: toSec(m[1], m[2], m[3], 0), text: m[4].split('|').map(p => (p.startsWith('/') ? `<i>${p.slice(1)}</i>` : p)).join('\n') });
    }
    return raw.map((c, i) => {
      const next = raw[i + 1] ? raw[i + 1].start : c.start + 4;
      const dur = Math.min(Math.max(1.5, 0.9 + c.text.length * 0.065), 6);
      return { start: c.start, end: Math.min(next, c.start + dur), text: c.text, top: false };
    }).filter(c => c.text.trim());
  }

  function parseSAMI(text) {
    const cues = [];
    const re = /<sync\s+start\s*=\s*"?(\d+)"?[^>]*>([\s\S]*?)(?=<sync|<\/body|$)/gi;
    let m;
    while ((m = re.exec(text))) {
      const body = m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<(?!\/?(i|b|u|font)\b)[^>]*>/gi, '').replace(/&nbsp;/g, ' ').trim();
      cues.push({ start: +m[1] / 1000, end: 0, text: body, top: false });
    }
    for (let i = 0; i < cues.length; i++) cues[i].end = cues[i + 1] ? cues[i + 1].start : cues[i].start + 4;
    return cues.filter(c => c.text);
  }

  K.parseSubtitles = function (text, opts = {}) {
    const t = text.replace(/^﻿/, '');
    const head = t.slice(0, 4000);
    let cues;
    if (/^\s*WEBVTT/.test(head)) cues = parseVTT(t);
    else if (/\[script info\]|^\s*dialogue:/im.test(head) || /\[events\]/i.test(t.slice(0, 20000))) cues = parseASS(t);
    else if (/-->/.test(head)) cues = parseSRT(t);
    else if (/^\s*\{\d+\}\{\d*\}/m.test(head)) cues = parseMicroDVD(t, opts.fps);
    else if (/^\s*\[\d+\]\[\d*\]/m.test(head)) cues = parseMPL2(t);
    else if (/<sami>/i.test(head)) cues = parseSAMI(t);
    else if (/^\s*\d{1,2}:\d{2}:\d{2}[:=]/m.test(head)) cues = parseTMP(t);
    else cues = [];
    cues = cues.filter(c => c.end > c.start).sort((a, b) => a.start - b.start);
    // collapse exact duplicates (ASS files often repeat lines for effects)
    const out = [];
    for (const c of cues) {
      const p = out[out.length - 1];
      if (p && p.start === c.start && p.end === c.end && p.text === c.text) continue;
      out.push(c);
    }
    return out;
  };

  // safe rendering of the markup subset
  function buildNodes(text, parent) {
    const stack = [parent];
    const re = /<(\/?)(i|b|u|font)([^>]*)>/gi;
    let last = 0, m;
    const addText = s => {
      if (!s) return;
      const parts = s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').split('\n');
      parts.forEach((p, i) => {
        if (i) stack[stack.length - 1].appendChild(document.createElement('br'));
        if (p) stack[stack.length - 1].appendChild(document.createTextNode(p));
      });
    };
    while ((m = re.exec(text))) {
      addText(text.slice(last, m.index));
      last = re.lastIndex;
      const tag = m[2].toLowerCase();
      if (m[1]) { if (stack.length > 1 && stack[stack.length - 1].dataset.tag === tag) stack.pop(); continue; }
      const el = document.createElement(tag === 'font' ? 'span' : tag);
      el.dataset.tag = tag;
      if (tag === 'font') {
        const c = /color\s*=\s*["']?(#[0-9a-f]{3,8}|[a-z]+)/i.exec(m[3]);
        if (c && /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(c[1])) el.style.color = c[1];
      }
      stack[stack.length - 1].appendChild(el);
      stack.push(el);
    }
    addText(text.slice(last));
  }

  class SubtitleView {
    constructor(el) {
      this.el = el;
      this.bottom = el.querySelector('.subs-bottom');
      this.topBox = el.querySelector('.subs-top');
      this.cues = [];
      this.key = '';
      this.hint = 0;
    }
    set(cues) { this.cues = cues || []; this.key = '\u0000'; this.hint = 0; }
    clear() { this.set([]); this.render(0); }
    active(t) {
      const c = this.cues;
      if (!c.length) return [];
      // binary search the last cue starting before t, then walk back over overlapping ones
      let lo = 0, hi = c.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      const out = [];
      for (let i = idx; i >= 0 && i > idx - 40; i--) if (c[i].end > t && c[i].start <= t) out.unshift(c[i]);
      return out;
    }
    render(t) {
      const list = this.active(t);
      const key = list.map(c => c.start + ':' + c.text).join('|');
      if (key === this.key) return;
      this.key = key;
      this.bottom.textContent = '';
      this.topBox.textContent = '';
      for (const c of list) {
        const line = document.createElement('div');
        line.className = 'sub-line';
        const span = document.createElement('span');
        buildNodes(c.text, span);
        line.appendChild(span);
        (c.top ? this.topBox : this.bottom).appendChild(line);
      }
    }
  }
  K.SubtitleView = SubtitleView;
})();
