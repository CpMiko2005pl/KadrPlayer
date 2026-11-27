K.createMovieCatalog = function (playMovie) {
  const dialog = document.getElementById('catalog');
  const $ = selector => dialog.querySelector(selector);
  const input = $('#catalog-query'), grid = $('#catalog-grid'), status = $('#catalog-status');
  const sections = { popular: 'Na czasie w Kadr', date: 'Ostatnio dodane filmy', series: 'Ostatnio dodane seriale' };
  const detail = $('#series-detail'), seasonSelect = $('#series-season'), episodeList = $('#series-episodes');
  let section = 'popular', query = '', page = 1, request = 0, loaded = false;
  const genre = $('#catalog-genre'), sort = $('#catalog-sort'), kind = $('#catalog-kind');
  const genres = { action: 'Akcja', animation: 'Animacja', biography: 'Biografia', documentary: 'Dokumentalny', drama: 'Dramat', family: 'Familijny', fantasy: 'Fantasy', history: 'Historyczny', horror: 'Horror', comedy: 'Komedia', crime: 'Kryminał', music: 'Muzyczny', musical: 'Musical', adventure: 'Przygodowy', romance: 'Romans', 'sci-fi': 'Science fiction', sport: 'Sportowy', mystery: 'Tajemnica', thriller: 'Thriller', western: 'Western', war: 'Wojenny' };
  for (const [slug, name] of Object.entries(genres)) genre.add(new Option(name, slug));
  const genreCache = new Map();
  let seriesRequest = 0;
  let popularPage = null, popularTime = 0;
  $('#catalog-close').innerHTML = K.icon('x');
  $('#series-close').innerHTML = K.icon('x');
  $('#series-close').onclick = closeSeries;

  function closeSeries() {
    seriesRequest++;
    detail.hidden = true;
  }

  function inertPage(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }

  function parsePage(html, section, page) {
    // Template content stays inert. Only data copied into new local elements reaches the UI.
    const doc = inertPage(html);
    const movies = new Map();
    for (const figure of doc.querySelectorAll('figure')) {
      const link = figure.querySelector('a[href]');
      const url = link && URL.parse(link.getAttribute('href'), 'https://hydrahd.com');
      if (!url || url.origin !== 'https://hydrahd.com' || !/^\/(movie|watchseries)\/[\w-]+\/?$/.test(url.pathname)) continue;
      const series = url.pathname.startsWith('/watchseries/');
      const image = link.querySelector('img');
      const title = (figure.querySelector('.detz')?.textContent || image?.alt || '').trim();
      if (!title || movies.has(url.pathname)) continue;
      const poster = URL.parse(image?.getAttribute('data-src') || image?.getAttribute('src') || '');
      const year = Array.from(link.querySelectorAll('span'), el => el.textContent.trim()).find(text => /^\d{4}$/.test(text));
      movies.set(url.pathname, { url: url.href, title, year, series, poster: poster?.origin === 'https://image.tmdb.org' ? poster.href : '' });
    }
    if (!movies.size && !(section === 'search' && /results for/i.test(doc.querySelector('h1')?.textContent || ''))) {
      throw new Error('Nie udało się odczytać listy filmów.');
    }
    const hasNext = Array.from(doc.querySelectorAll('.pagination a[href]')).some(a => a.textContent.trim() === String(page + 1) || /^next\b/i.test(a.textContent.trim()));
    return { movies: [...movies.values()], hasNext };
  }

  async function showSeries(series) {
    const id = ++seriesRequest;
    const feedback = $('#series-status'), seasonLabel = $('#series-season-label');
    detail.hidden = false;
    seasonLabel.hidden = true;
    $('#series-title').textContent = series.title;
    feedback.textContent = 'Wczytywanie sezonów…';
    episodeList.replaceChildren();
    seasonSelect.replaceChildren();
    try {
      const doc = inertPage(await window.kadr.seriesDetails(series.url));
      if (id !== seriesRequest) return;
      const seasons = new Map();
      for (const link of doc.querySelectorAll('a.dynamic-ep-link[data-season][data-episode]')) {
        const season = Number(link.dataset.season), number = Number(link.dataset.episode);
        if (!/^\d{1,4}$/.test(link.dataset.season) || !/^\d{1,5}$/.test(link.dataset.episode)) continue;
        if (!seasons.has(season)) seasons.set(season, new Map());
        const name = link.querySelector('.tv_episode_name')?.textContent.trim().replace(/^[-–—:\s]+/, '') || '';
        const code = 'S' + String(season).padStart(2, '0') + 'E' + String(number).padStart(2, '0');
        const url = new URL(series.url);
        url.pathname = url.pathname.replace(/\/$/, '') + '/season/' + season + '/episode/' + number;
        seasons.get(season).set(number, { url: url.href, title: series.title + ' · ' + code + (name ? ' · ' + name : ''), name, number });
      }
      if (!seasons.size) {
        feedback.textContent = 'Ten serial nie ma dostępnej listy odcinków.';
        return;
      }
      for (const season of [...seasons.keys()].sort((a, b) => a - b)) {
        seasonSelect.add(new Option(season === 0 ? 'Odcinki specjalne' : 'Sezon ' + season, season));
      }
      seasonSelect.onchange = () => {
        const episodes = [...seasons.get(Number(seasonSelect.value)).values()].sort((a, b) => a.number - b.number);
        episodeList.replaceChildren(...episodes.map((episode, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Odcinek ' + episode.number + (episode.name ? ' · ' + episode.name : '');
          button.onclick = () => { dialog.close(); playMovie(episode, episodes, index); };
          return button;
        }));
      };
      feedback.textContent = '';
      seasonSelect.onchange();
      seasonLabel.hidden = false;
      if (dialog.open) seasonSelect.focus();
    } catch {
      if (id !== seriesRequest) return;
      feedback.textContent = 'Nie udało się wczytać sezonów.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Spróbuj ponownie';
      retry.onclick = () => showSeries(series);
      episodeList.append(retry);
    }
  }

  async function searchFilters(movies, id, slug, type) {
    const candidates = movies.filter(movie => slug ? !movie.series : !type || movie.series === (type === 'series'));
    if (!slug) return candidates;
    const matches = new Set();
    let index = 0;
    async function worker() {
      while (index < candidates.length && id === request) {
        const movie = candidates[index++];
        if (!genreCache.has(movie.url)) {
          const doc = inertPage(await window.kadr.movieDetails(movie.url));
          const links = [...doc.querySelectorAll('a[href*="/genres/watch-"]')];
          if (genreCache.size >= 500) genreCache.delete(genreCache.keys().next().value);
          genreCache.set(movie.url, links.map(a => URL.parse(a.getAttribute('href'), movie.url)?.pathname));
        }
        if (genreCache.get(movie.url).includes('/genres/watch-' + slug + '-movies-online-free')) matches.add(movie.url);
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
    return candidates.filter(movie => matches.has(movie.url));
  }

  function getPage(section, query, page) {
    const fetchPage = () => window.kadr.listMovies({ section, query, page, genre: genre.value, sort: sort.value }).then(html => parsePage(html, section, page));
    if (section !== 'popular' || page !== 1) return fetchPage();
    if (!popularPage || Date.now() - popularTime > 300000) {
      popularTime = Date.now();
      popularPage = fetchPage().catch(err => { popularPage = null; throw err; });
    }
    return popularPage;
  }

  function makeCard(movie, feedback) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'movie-card';
    const poster = document.createElement('span');
    poster.className = 'movie-poster';
    poster.innerHTML = K.icon('film');
    if (movie.poster) {
      const img = document.createElement('img');
      img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      img.src = movie.poster;
      poster.append(img);
    }
    const title = document.createElement('b');
    title.textContent = movie.title;
    button.append(poster, title);
    if (movie.year || movie.series) {
      const year = document.createElement('small');
      year.textContent = [movie.series ? 'Serial' : '', movie.year].filter(Boolean).join(' · ');
      button.append(year);
    }
    button.addEventListener('click', () => {
      feedback.textContent = '';
      if (movie.series) { showSeries(movie); return; }
      if (dialog.open) dialog.close();
      playMovie(movie);
    });
    return button;
  }

  async function load() {
    const id = ++request;
    closeSeries();
    loaded = false;
    for (const tab of dialog.querySelectorAll('[data-section]')) tab.setAttribute('aria-pressed', String(tab.dataset.section === section));
    $('#catalog-sort-label').hidden = section !== 'genre';
    $('#catalog-kind-label').hidden = section !== 'search' || !!genre.value;
    $('#catalog-heading').textContent = section === 'search' ? 'Wyniki dla „' + query + '”' : (section === 'genre' ? genres[genre.value] : sections[section]);
    $('#catalog-content').scrollTop = 0;
    $('#catalog-pages').hidden = true;
    $('#catalog-retry').hidden = true;
    status.textContent = 'Wczytywanie tytułów…';
    grid.replaceChildren();
    try {
      const result = await getPage(section, query, page);
      if (id !== request) return;
      const { hasNext } = result;
      const movies = section === 'search' ? await searchFilters(result.movies, id, genre.value, kind.value) : result.movies;
      if (id !== request) return;
      grid.replaceChildren(...movies.map(movie => makeCard(movie, status)));
      status.textContent = movies.length ? '' : 'Brak wyników na tej stronie. Spróbuj innego tytułu.';
      $('#catalog-page').textContent = 'Strona ' + page;
      $('#catalog-prev').disabled = page === 1;
      $('#catalog-next').disabled = !hasNext;
      $('#catalog-pages').hidden = !hasNext && page === 1;
      loaded = true;
    } catch {
      if (id !== request) return;
      status.textContent = 'Katalog Kadr jest teraz niedostępny.';
      $('#catalog-retry').hidden = false;
    }
  }

  for (const tab of dialog.querySelectorAll('[data-section]')) tab.onclick = () => {
    genre.value = sort.value = kind.value = '';
    section = tab.dataset.section; query = ''; input.value = ''; page = 1; load();
  };
  function applyFilters() {
    query = input.value.trim();
    section = query ? 'search' : genre.value ? 'genre' : 'popular';
    page = 1;
    load();
  }
  genre.onchange = sort.onchange = kind.onchange = applyFilters;
  $('#catalog-search').onsubmit = event => { event.preventDefault(); applyFilters(); };
  $('#catalog-prev').onclick = () => { if (page > 1) { page--; load(); } };
  $('#catalog-next').onclick = () => { page++; load(); };
  $('#catalog-retry').onclick = load;
  $('#catalog-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { request++; });
  const shelf = document.getElementById('home-films');
  function showShelf(movies) {
    const feedback = document.getElementById('home-film-status');
    document.getElementById('home-film-grid').replaceChildren(...movies.slice(0, 6).map(movie => makeCard(movie, feedback)));
    shelf.hidden = false;
  }
  getPage('popular', '', 1).then(result => showShelf(result.movies)).catch(() => {});
  return function open(popular = false) {
    if (dialog.open) return;
    dialog.showModal();
    if (!popular && !detail.hidden && !$('#series-season-label').hidden) seasonSelect.focus();
    else input.focus();
    if (popular) { genre.value = sort.value = kind.value = ''; section = 'popular'; page = 1; query = ''; input.value = ''; }
    if (popular || !loaded) load();
  };
};
