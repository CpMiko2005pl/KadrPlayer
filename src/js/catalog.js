K.createMovieCatalog = function (pauseLocal) {
  const dialog = document.getElementById('catalog');
  const $ = selector => dialog.querySelector(selector);
  const input = $('#catalog-query'), grid = $('#catalog-grid'), status = $('#catalog-status');
  const sections = { popular: 'Na czasie w HydraHD', date: 'Ostatnio dodane' };
  let section = 'popular', query = '', page = 1, request = 0, loaded = false;
  let popularPage = null, popularTime = 0;
  $('#catalog-close').innerHTML = K.icon('x');

  function parsePage(html, section, page) {
    // Template content stays inert. Only data copied into new local elements reaches the UI.
    const template = document.createElement('template');
    template.innerHTML = html;
    const doc = template.content;
    const movies = new Map();
    for (const figure of doc.querySelectorAll('figure')) {
      const link = figure.querySelector('a[href]');
      const url = link && URL.parse(link.getAttribute('href'), 'https://hydrahd.com');
      if (!url || url.origin !== 'https://hydrahd.com' || !/^\/movie\/[\w-]+\/?$/.test(url.pathname)) continue;
      const image = link.querySelector('img');
      const title = (figure.querySelector('.detz')?.textContent || image?.alt || '').trim();
      if (!title || movies.has(url.pathname)) continue;
      const poster = URL.parse(image?.getAttribute('data-src') || image?.getAttribute('src') || '');
      const year = Array.from(link.querySelectorAll('span'), el => el.textContent.trim()).find(text => /^\d{4}$/.test(text));
      movies.set(url.pathname, { url: url.href, title, year, poster: poster?.origin === 'https://image.tmdb.org' ? poster.href : '' });
    }
    if (!movies.size && !(section === 'search' && /results for/i.test(doc.querySelector('h1')?.textContent || ''))) {
      throw new Error('Nie udało się odczytać listy filmów.');
    }
    const hasNext = Array.from(doc.querySelectorAll('.pagination a[href]')).some(a => a.textContent.trim() === String(page + 1) || /^next\b/i.test(a.textContent.trim()));
    return { movies: [...movies.values()], hasNext };
  }

  function getPage(section, query, page) {
    const fetchPage = () => window.kadr.listMovies({ section, query, page }).then(html => parsePage(html, section, page));
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
    if (movie.year) {
      const year = document.createElement('small');
      year.textContent = movie.year;
      button.append(year);
    }
    button.addEventListener('click', async () => {
      pauseLocal();
      try { await window.kadr.playMovie(movie.url, movie.title); }
      catch { feedback.textContent = 'Nie udało się otworzyć filmu. Spróbuj ponownie lub wybierz inny tytuł.'; }
    });
    return button;
  }

  async function load() {
    const id = ++request;
    loaded = false;
    for (const tab of dialog.querySelectorAll('[data-section]')) tab.setAttribute('aria-pressed', String(tab.dataset.section === section));
    $('#catalog-heading').textContent = section === 'search' ? 'Wyniki dla „' + query + '”' : sections[section];
    $('#catalog-content').scrollTop = 0;
    $('#catalog-pages').hidden = true;
    $('#catalog-retry').hidden = true;
    status.textContent = 'Wczytywanie filmów…';
    grid.replaceChildren();
    try {
      const { movies, hasNext } = await getPage(section, query, page);
      if (id !== request) return;
      grid.replaceChildren(...movies.map(movie => makeCard(movie, status)));
      status.textContent = movies.length ? '' : 'Brak filmów na tej stronie wyników. Spróbuj innego tytułu.';
      $('#catalog-page').textContent = 'Strona ' + page;
      $('#catalog-prev').disabled = page === 1;
      $('#catalog-next').disabled = !hasNext;
      $('#catalog-pages').hidden = !hasNext && page === 1;
      loaded = true;
    } catch {
      if (id !== request) return;
      status.textContent = 'Katalog HydraHD jest teraz niedostępny.';
      $('#catalog-retry').hidden = false;
    }
  }

  for (const tab of dialog.querySelectorAll('[data-section]')) tab.onclick = () => {
    section = tab.dataset.section; query = ''; input.value = ''; page = 1; load();
  };
  $('#catalog-search').onsubmit = event => {
    event.preventDefault();
    query = input.value.trim(); section = query ? 'search' : 'popular'; page = 1; load();
  };
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
    input.focus();
    if (popular) { section = 'popular'; page = 1; query = ''; input.value = ''; }
    if (popular || !loaded) load();
  };
};
