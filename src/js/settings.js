// Kadr Player — settings: defaults, the schema of the settings drawer and a tiny form builder
window.K = window.K || {};
(() => {
  K.DEFAULTS = {
    // picture
    renderer: 'gl', scaler: 'lanczos', antiring: 0.6, linear: true, sharpen: 0, deband: false, debandStrength: 0.5, dither: true,
    smooth: false, renderScale: 1, fpsLimit: 0,
    bright: 0, contr: 1, sat: 1, gamma: 1, hue: 0,
    fit: 'fit', aspect: 'auto', zoom: 1, rotate: 0, flipH: false, flipV: false, autoCrop: false,
    // decoding / conversion
    hwdec: true, playMode: 'auto', encoder: 'auto', quality: 'balanced', maxHeight: 0, deint: 'auto', tonemap: true,
    interp: 'off', interpFps: 60, bufferAhead: 60,
    // behaviour
    resume: true, autoNext: true, autoFolder: true, fitWindow: false, seekStep: 5, fastSeek: false, onTop: false, thumbs: true, clickPause: true,
    // sound
    volume: 1, muted: false, volumeMax: 1.5, eqOn: false, eqPreset: 'flat', eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0,
    normalize: false, dialog: false, mono: false, audioDelay: 0, stereo: false, preservesPitch: true, audioLang: 'pol,eng', sink: 'default',
    // subtitles
    subsAuto: true, subLang: 'pol,eng', subSize: 5.2, subColor: '#ffffff', subOutline: 2.2, subBg: 0, subPos: 6, subFont: 'Segoe UI',
    subBold: true, subMargins: false, burnAss: false,
    repeat: 'off', shuffle: false,
  };

  const opt = (...pairs) => pairs;
  const pct = v => Math.round(v * 100) + '%';

  // each row: { key, type: select|toggle|range|color|text|button|eq|info|heading, label, hint, options, min, max, step, fmt, when }
  K.SCHEMA = [
    { id: 'picture', title: 'Obraz', rows: [
      { type: 'heading', label: 'Renderowanie' },
      { key: 'renderer', type: 'select', label: 'Renderer', hint: 'Zaawansowany włącza filtry poniżej. Obraz HDR jest automatycznie wyświetlany natywnie.',
        options: opt(['gl', 'Zaawansowany (WebGL2)'], ['native', 'Natywny (najlżejszy, HDR)']) },
      { key: 'scaler', type: 'select', label: 'Skalowanie obrazu', hint: 'Lanczos-3 daje najostrzejszy obraz; przy pomniejszaniu jądro jest poszerzane, więc nie ma migotania i schodków.', gl: true,
        options: opt(['lanczos', 'Lanczos-3 (najwyższa jakość)'], ['spline36', 'Spline36 (ostry, mniej obwódek)'], ['mitchell', 'Mitchell-Netravali (miękki)'], ['catrom', 'Catmull-Rom (bicubic)'], ['bilinear', 'Dwuliniowe (najszybsze)'], ['nearest', 'Najbliższy sąsiad (pixel-art)']) },
      { key: 'antiring', type: 'range', label: 'Redukcja obwódek (anti-ringing)', min: 0, max: 1, step: 0.05, fmt: pct, gl: true, when: s => ['lanczos', 'spline36', 'catrom'].includes(s.scaler) },
      { key: 'linear', type: 'toggle', label: 'Pomniejszanie w świetle liniowym', hint: 'Poprawne jasności drobnych detali przy pomniejszaniu (np. 4K na ekranie Full HD).', gl: true },
      { key: 'sharpen', type: 'range', label: 'Wyostrzanie (AMD FidelityFX RCAS)', min: 0, max: 1, step: 0.05, fmt: v => (v ? pct(v) : 'wył.'), gl: true },
      { key: 'deband', type: 'toggle', label: 'Usuwanie pasm (deband)', hint: 'Wygładza „schodki” w gradientach nieba i ciemnych scenach słabo skompresowanych plików.', gl: true },
      { key: 'debandStrength', type: 'range', label: 'Siła usuwania pasm', min: 0, max: 1, step: 0.05, fmt: pct, gl: true, when: s => s.deband },
      { key: 'dither', type: 'toggle', label: 'Dithering', hint: 'Ukrywa pasma przy 8-bitowym wyjściu.', gl: true },
      { key: 'renderScale', type: 'select', label: 'Rozdzielczość renderowania', hint: 'Mniej niż 100% odciąża słabą kartę graficzną.', gl: true,
        options: opt([0.5, '50% (oszczędnie)'], [0.75, '75%'], [1, '100% — natywna ekranu'], [1.5, '150% (supersampling)'], [2, '200% (supersampling)']) },
      { type: 'heading', label: 'Płynność' },
      { key: 'smooth', type: 'toggle', label: 'Płynny ruch (bez judderu)', hint: 'Synchronizuje klatki filmu z odświeżaniem ekranu przez miękkie przejście (jak „interpolation” w mpv). Dźwięk jest automatycznie opóźniany o 1 klatkę.', gl: true },
      { key: 'fpsLimit', type: 'select', label: 'Limit klatek renderowania', hint: 'Ogranicza zużycie GPU i baterii.', gl: true,
        options: opt([0, 'Bez limitu (odświeżanie ekranu)'], [24, '24 kl/s'], [30, '30 kl/s'], [60, '60 kl/s'], [120, '120 kl/s'], [144, '144 kl/s']) },
      { key: 'interp', type: 'select', label: 'Interpolacja klatek (ffmpeg)', hint: 'Tworzy nowe klatki. Mieszanie jest lekkie; MCI (ruch jak w telewizorach) bardzo obciąża procesor — najlepiej z niższą rozdzielczością konwersji.',
        options: opt(['off', 'Wyłączona'], ['blend', 'Mieszanie klatek'], ['mci', 'Interpolacja ruchu MCI (ciężka)']) },
      { key: 'interpFps', type: 'select', label: 'Docelowe kl/s interpolacji', when: s => s.interp !== 'off',
        options: opt([48, '48'], [50, '50'], [60, '60'], [90, '90'], [120, '120'], [144, '144']) },
      { type: 'heading', label: 'Kadr i proporcje' },
      { key: 'fit', type: 'select', label: 'Dopasowanie', options: opt(['fit', 'Dopasuj (czarne pasy)'], ['fill', 'Wypełnij (przytnij)'], ['stretch', 'Rozciągnij'], ['native', 'Oryginalny rozmiar 1:1'], ['integer', 'Całkowita wielokrotność (ostre piksele)']) },
      { key: 'aspect', type: 'select', label: 'Proporcje obrazu', options: opt(['auto', 'Automatyczne'], ['16:9', '16:9'], ['4:3', '4:3'], ['21:9', '21:9'], ['2.35:1', '2.35:1 (kino)'], ['1.85:1', '1.85:1'], ['1:1', '1:1'], ['9:16', '9:16 (pionowe)']) },
      { key: 'zoom', type: 'range', label: 'Powiększenie', min: 0.5, max: 3, step: 0.05, fmt: pct },
      { key: 'rotate', type: 'select', label: 'Obrót', options: opt([0, 'Brak'], [90, '90° w prawo'], [180, '180°'], [270, '90° w lewo']) },
      { key: 'flipH', type: 'toggle', label: 'Odbicie lustrzane' },
      { key: 'flipV', type: 'toggle', label: 'Odbicie pionowe' },
      { key: 'autoCrop', type: 'toggle', label: 'Automatycznie usuwaj czarne pasy', hint: 'Wykrywa pasy wtopione w obraz (np. film 21:9 zapisany jako 16:9). Klawisz C — tylko bieżący plik.' },
      { type: 'heading', label: 'Kolory', action: { label: 'Resetuj', run: 'reset-colors' } },
      { key: 'bright', type: 'range', label: 'Jasność', min: -0.5, max: 0.5, step: 0.01, fmt: v => (v > 0 ? '+' : '') + Math.round(v * 100) },
      { key: 'contr', type: 'range', label: 'Kontrast', min: 0.5, max: 1.8, step: 0.01, fmt: pct },
      { key: 'sat', type: 'range', label: 'Nasycenie', min: 0, max: 2, step: 0.01, fmt: pct },
      { key: 'gamma', type: 'range', label: 'Gamma', min: 0.5, max: 2, step: 0.01, fmt: v => v.toFixed(2) },
      { key: 'hue', type: 'range', label: 'Odcień', min: -180, max: 180, step: 1, fmt: v => v + '°' },
    ] },
    { id: 'quality', title: 'Jakość', rows: [
      { type: 'info', id: 'mode-info' },
      { type: 'heading', label: 'Dekodowanie' },
      { key: 'hwdec', type: 'toggle', label: 'Dekodowanie sprzętowe (GPU)', hint: 'Mniejsze obciążenie procesora i baterii. Zmiana wymaga ponownego uruchomienia.', restart: true },
      { key: 'playMode', type: 'select', label: 'Sposób odtwarzania', hint: 'Automatycznie: plik bezpośrednio, a gdy trzeba — przepakowanie bez utraty jakości albo konwersja w locie.',
        options: opt(['auto', 'Automatycznie (zalecane)'], ['remux', 'Zawsze przez ffmpeg (bez konwersji, gdy się da)'], ['encode', 'Zawsze konwertuj w locie']) },
      { type: 'heading', label: 'Konwersja w locie' },
      { key: 'encoder', type: 'select', label: 'Koder', hint: 'Sprzętowe kodery są szybkie i nie obciążają procesora.', options: 'encoders' },
      { key: 'quality', type: 'select', label: 'Jakość konwersji', options: opt(['max', 'Najwyższa'], ['balanced', 'Zrównoważona'], ['fast', 'Wydajność (słabszy komputer)']) },
      { key: 'maxHeight', type: 'select', label: 'Rozdzielczość konwersji', hint: 'Zmniejsz, jeśli konwersja nie nadąża (film się zacina).',
        options: opt([0, 'Oryginalna'], [2160, 'Do 2160p (4K)'], [1440, 'Do 1440p'], [1080, 'Do 1080p'], [720, 'Do 720p'], [480, 'Do 480p']) },
      { key: 'deint', type: 'select', label: 'Usuwanie przeplotu', hint: 'bwdif z podwojeniem klatek — płynny obraz z nagrań TV i DVD.', options: opt(['auto', 'Automatycznie'], ['on', 'Zawsze'], ['off', 'Nigdy']) },
      { key: 'tonemap', type: 'toggle', label: 'HDR → SDR (mapowanie tonów)', hint: 'Przy konwersji filmów HDR10/HLG: naturalne kolory zamiast szarego obrazu.' },
      { key: 'stereo', type: 'toggle', label: 'Miksuj dźwięk przestrzenny do stereo', hint: 'Przy konwersji 5.1/7.1 → 2.0.' },
      { key: 'bufferAhead', type: 'select', label: 'Bufor naprzód', options: opt([20, '20 s'], [60, '60 s'], [120, '2 min'], [300, '5 min']) },
      { type: 'heading', label: 'Odtwarzanie' },
      { key: 'resume', type: 'toggle', label: 'Wznawiaj od miejsca, w którym skończyłeś' },
      { key: 'autoNext', type: 'toggle', label: 'Odtwarzaj następny plik z listy' },
      { key: 'autoFolder', type: 'toggle', label: 'Dodawaj pozostałe filmy z folderu', hint: 'Po otwarciu jednego odcinka kolejne trafiają na listę.' },
      { key: 'seekStep', type: 'select', label: 'Przewijanie strzałkami', options: opt([3, '3 s'], [5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s']) },
      { key: 'fastSeek', type: 'toggle', label: 'Szybkie przewijanie do klatek kluczowych', hint: 'Natychmiastowe skoki kosztem dokładności.' },
      { key: 'thumbs', type: 'toggle', label: 'Podgląd klatki nad paskiem czasu' },
      { key: 'clickPause', type: 'toggle', label: 'Kliknięcie w obraz = pauza' },
      { key: 'fitWindow', type: 'toggle', label: 'Dopasuj okno do rozmiaru filmu' },
      { key: 'onTop', type: 'toggle', label: 'Zawsze na wierzchu' },
    ] },
    { id: 'audio', title: 'Dźwięk', rows: [
      { key: 'sink', type: 'select', label: 'Urządzenie wyjściowe', options: 'sinks' },
      { key: 'volumeMax', type: 'select', label: 'Maksymalna głośność', hint: 'Wzmocnienie ponad 100% dla cichych nagrań.', options: opt([1, '100%'], [1.5, '150%'], [2, '200%']) },
      { key: 'normalize', type: 'toggle', label: 'Wyrównywanie głośności (tryb nocny)', hint: 'Ciche dialogi głośniej, wybuchy ciszej.' },
      { key: 'dialog', type: 'toggle', label: 'Wyraźne dialogi', hint: 'Podbija pasmo mowy i przycina dudnienie.' },
      { key: 'mono', type: 'toggle', label: 'Mono', hint: 'Np. dla jednej słuchawki.' },
      { key: 'audioDelay', type: 'range', label: 'Opóźnienie dźwięku', hint: 'Gdy dźwięk wyprzedza obraz w danym pliku.', min: 0, max: 2000, step: 10, fmt: v => v + ' ms' },
      { key: 'preservesPitch', type: 'toggle', label: 'Zachowaj ton przy zmianie prędkości' },
      { key: 'audioLang', type: 'text', label: 'Preferowane języki ścieżek', hint: 'Kody ISO, po przecinku, np. pol,eng.' },
      { type: 'heading', label: 'Korektor graficzny', toggle: 'eqOn' },
      { key: 'eqPreset', type: 'select', label: 'Ustawienie', options: 'eqPresets', when: s => s.eqOn },
      { type: 'eq', when: s => s.eqOn },
      { key: 'preamp', type: 'range', label: 'Przedwzmacniacz', min: -12, max: 12, step: 0.5, fmt: v => (v > 0 ? '+' : '') + v + ' dB', when: s => s.eqOn },
    ] },
    { id: 'subs', title: 'Napisy', rows: [
      { key: 'subsAuto', type: 'toggle', label: 'Wczytuj napisy automatycznie', hint: 'Pliki obok filmu (SRT, ASS, TXT/MicroDVD, MPL2…) i ścieżki wbudowane w preferowanym języku.' },
      { key: 'subLang', type: 'text', label: 'Preferowane języki napisów', hint: 'Np. pol,eng' },
      { key: 'subSize', type: 'range', label: 'Wielkość', min: 2.5, max: 10, step: 0.1, fmt: v => v.toFixed(1) },
      { key: 'subFont', type: 'select', label: 'Czcionka', options: opt(['Segoe UI', 'Segoe UI'], ['Arial', 'Arial'], ['Verdana', 'Verdana'], ['Tahoma', 'Tahoma'], ['Calibri', 'Calibri'], ['Trebuchet MS', 'Trebuchet MS'], ['Georgia', 'Georgia'], ['Inter', 'Inter']) },
      { key: 'subBold', type: 'toggle', label: 'Pogrubienie' },
      { key: 'subColor', type: 'color', label: 'Kolor' },
      { key: 'subOutline', type: 'range', label: 'Obrys', min: 0, max: 5, step: 0.1, fmt: v => v.toFixed(1) },
      { key: 'subBg', type: 'range', label: 'Tło pod napisami', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'subPos', type: 'range', label: 'Wysokość nad dolną krawędzią', min: 0, max: 40, step: 0.5, fmt: v => v + '%' },
      { key: 'subMargins', type: 'toggle', label: 'Napisy na czarnych pasach', hint: 'Gdy obraz ma pasy u dołu, napisy trafiają na pas i nie zasłaniają filmu.' },
      { key: 'burnAss', type: 'toggle', label: 'Napisy ASS w oryginalnym stylu', hint: 'Wypala stylizowane napisy (anime, karaoke) przez konwersję w locie.' },
      { type: 'info', id: 'subs-keys', html: '<b>Z</b> / <b>X</b> — przesunięcie napisów o ∓0,1 s, <b>V</b> — następne napisy, <b>Shift+V</b> — wyłącz.' },
    ] },
    { id: 'about', title: 'Program', rows: [{ type: 'about' }] },
  ];

  // ---------- form builder ----------
  K.buildPanel = function (body, tab, ctx) {
    body.textContent = '';
    const S = ctx.settings;
    const sec = K.SCHEMA.find(t => t.id === tab);
    if (!sec) return;
    const refresh = () => K.buildPanel(body, tab, ctx);
    for (const row of sec.rows) {
      if (row.gl && S.renderer !== 'gl') continue;
      if (row.when && !row.when(S)) continue;
      if (row.type === 'heading') {
        const h = document.createElement('div');
        h.className = 'sec';
        h.textContent = row.label;
        if (row.action) {
          const b = document.createElement('button'); b.className = 'btn small ghost'; b.textContent = row.action.label;
          b.onclick = () => { ctx.action(row.action.run); refresh(); };
          h.appendChild(b);
        }
        if (row.toggle) {
          const t = document.createElement('button'); t.className = 'sw' + (S[row.toggle] ? ' on' : '');
          t.onclick = () => { ctx.set(row.toggle, !S[row.toggle]); refresh(); };
          h.appendChild(t);
        }
        body.appendChild(h);
        continue;
      }
      if (row.type === 'info') {
        const d = document.createElement('div'); d.className = 'info-box';
        if (row.html) d.innerHTML = row.html; else ctx.info(row.id, d);
        body.appendChild(d);
        continue;
      }
      if (row.type === 'about') { ctx.about(body); continue; }
      if (row.type === 'eq') { body.appendChild(eqRow(S, ctx)); continue; }
      const el = document.createElement('div');
      el.className = 'set';
      const lbl = document.createElement('div'); lbl.className = 'lbl';
      const b = document.createElement('b'); b.textContent = row.label; lbl.appendChild(b);
      if (row.hint) { const sm = document.createElement('small'); sm.textContent = row.hint; lbl.appendChild(sm); }
      el.appendChild(lbl);
      let ctl;
      if (row.type === 'toggle') {
        ctl = document.createElement('button'); ctl.className = 'sw' + (S[row.key] ? ' on' : '');
        ctl.onclick = () => { ctx.set(row.key, !S[row.key]); refresh(); };
      } else if (row.type === 'select') {
        ctl = document.createElement('select');
        const options = typeof row.options === 'string' ? ctx.options(row.options) : row.options;
        for (const [v, l] of options) { const o = document.createElement('option'); o.value = String(v); o.textContent = l; ctl.appendChild(o); }
        ctl.value = String(S[row.key]);
        ctl.onchange = () => {
          const raw = ctl.value;
          const sample = options.find(o => String(o[0]) === raw);
          ctx.set(row.key, sample ? sample[0] : raw);
          refresh();
        };
      } else if (row.type === 'range') {
        el.classList.add('col');
        ctl = document.createElement('div'); ctl.className = 'rng';
        const inp = document.createElement('input'); inp.type = 'range'; inp.min = row.min; inp.max = row.max; inp.step = row.step; inp.value = S[row.key];
        const out = document.createElement('output');
        const show = () => { out.textContent = row.fmt ? row.fmt(+inp.value) : inp.value; inp.style.setProperty('--p', ((inp.value - row.min) / (row.max - row.min) * 100) + '%'); };
        inp.oninput = () => { show(); ctx.set(row.key, +inp.value, true); };
        inp.onchange = () => ctx.set(row.key, +inp.value);
        inp.ondblclick = () => { const d = K.DEFAULTS[row.key]; inp.value = d; show(); ctx.set(row.key, d); };
        show();
        ctl.append(inp, out);
      } else if (row.type === 'color') {
        ctl = document.createElement('input'); ctl.type = 'color'; ctl.value = S[row.key];
        ctl.oninput = () => ctx.set(row.key, ctl.value, true);
        ctl.onchange = () => ctx.set(row.key, ctl.value);
      } else if (row.type === 'text') {
        ctl = document.createElement('input'); ctl.type = 'text'; ctl.value = S[row.key]; ctl.style.width = '120px';
        ctl.onchange = () => ctx.set(row.key, ctl.value.trim());
        ctl.onkeydown = e => e.stopPropagation();
      }
      el.appendChild(ctl);
      body.appendChild(el);
    }
  };

  function eqRow(S, ctx) {
    const wrap = document.createElement('div'); wrap.className = 'eq';
    K.EQ_BANDS.forEach((f, i) => {
      const band = document.createElement('div'); band.className = 'band';
      const out = document.createElement('output');
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = -12; inp.max = 12; inp.step = 0.5; inp.value = S.eq[i];
      const show = () => { out.textContent = (inp.value > 0 ? '+' : '') + (+inp.value); inp.style.setProperty('--p', ((+inp.value + 12) / 24 * 100) + '%'); };
      inp.oninput = () => { show(); const eq = S.eq.slice(); eq[i] = +inp.value; ctx.set('eq', eq, true); };
      inp.onchange = () => { const eq = S.eq.slice(); eq[i] = +inp.value; ctx.set('eq', eq); ctx.set('eqPreset', 'custom'); };
      inp.ondblclick = () => { inp.value = 0; show(); const eq = S.eq.slice(); eq[i] = 0; ctx.set('eq', eq); };
      show();
      const lab = document.createElement('span'); lab.textContent = f >= 1000 ? (f / 1000) + 'k' : f;
      band.append(out, inp, lab);
      wrap.appendChild(band);
    });
    return wrap;
  }
})();
