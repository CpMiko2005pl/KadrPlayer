// Kadr — updates from the public GitHub releases of CpMiko2005pl/KadrPlayer (electron-updater, NSIS).
// Nothing is downloaded or installed without the user's click; the movie keeps playing until "restart and install".
function createUpdates({ getUpdater, installed, notify }) {
  let updater, checking, downloading;
  let state = { phase: 'idle', version: '', message: '' };
  function publish(phase, message, version = state.version) {
    state = { phase, message, version };
    notify(state);
    return state;
  }
  function fail(error) {
    const text = String(error && (error.message || error));
    const offline = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_(REFUSED|RESET|TIMED_OUT|CLOSED)|ERR_TIMED_OUT|ERR_PROXY|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(text);
    const denied = /\b(401|403|404)\b|unauthorized|forbidden|rate limit/i.test(text);
    if (error && error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return publish('error', 'Ostatnie wydanie nie zawiera metadanych aktualizacji (latest.yml).');
    if (error && error.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') return publish('error', 'Nie znaleziono opublikowanego wydania Kadr.');
    if (offline) return publish('offline', 'Brak połączenia z internetem — nie można sprawdzić aktualizacji.');
    return publish('error', denied ? 'Serwer wydań odmówił dostępu (repozytorium niedostępne lub limit zapytań GitHub). Spróbuj później.'
      : 'Nie udało się pobrać lub zweryfikować aktualizacji. Spróbuj ponownie.');
  }
  function client() {
    if (updater) return updater;
    updater = getUpdater();
    updater.logger = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on('error', fail);
    updater.on('update-available', info => publish('available', 'Dostępna aktualizacja Kadr Player', info.version));
    updater.on('update-not-available', () => publish('current', 'Masz aktualną wersję Kadr.', ''));
    updater.on('download-progress', p => publish('downloading', 'Pobieranie aktualizacji · ' + Math.floor(p.percent) + '%'));
    updater.on('update-downloaded', info => publish('ready', 'Aktualizacja jest gotowa.', info.version));
    return updater;
  }
  async function check() {
    if (!installed) return publish('development', 'Aktualizacje są dostępne w zainstalowanej aplikacji Windows.');
    if (downloading || state.phase === 'ready') return state;
    if (checking) return checking;
    checking = (async () => {
      publish('checking', 'Sprawdzanie aktualizacji…', '');
      try {
        await client().checkForUpdates();     // feed: app-update.yml written by electron-builder from "publish"
        return state;
      } catch (e) { return fail(e); }
    })();
    try { return await checking; } finally { checking = null; }
  }
  async function download() {
    if (state.phase !== 'available' || downloading) return state;
    publish('downloading', 'Pobieranie aktualizacji…');
    downloading = Promise.resolve().then(() => client().downloadUpdate());
    try { await downloading; } catch (e) { fail(e); } finally { downloading = null; }
    return state;
  }
  return { check, download, status: () => state, install() {
    // silent NSIS run (no wizard/sponsor pages again), then Kadr starts on its own
    if (state.phase === 'ready') client().quitAndInstall(true, true);
  } };
}

module.exports = { createUpdates };
