const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { movieQuality, localProfile } = require('../src/js/quality');
const { createUpdates } = require('../updates');

async function test() {
  const video = { currentTime: 20, paused: true, volume: 0.25, videoHeight: 720, textTracks: [{}] };
  const hls = { levels: [480,720,1080,2160].map(height => ({height})), currentLevel: 1,
    set nextLevel(i) { this.currentLevel = i; video.videoHeight = this.levels[i]?.height || 720; } };
  global.document = { querySelector: () => video, querySelectorAll: () => [] };
  global.window = { hls };
  for (const [cap,expected] of [[0,2160],[1080,1080],[900,720],[480,480]]) {
    const info = movieQuality(cap);
    assert.equal(info.selected, expected);
    assert.equal(info.height, expected);
  }
  hls.levels = [{height:720}];hls.currentLevel = 0;video.videoHeight = 720;
  assert.deepEqual(movieQuality(480).heights,[720]);
  assert.equal(movieQuality(480).height,720);
  delete window.hls;
  assert.deepEqual(movieQuality(720).heights,[]);
  assert.equal(video.currentTime,20);
  assert.equal(video.paused,true);
  assert.equal(video.volume,0.25);
  assert.equal(video.textTracks.length,1);
  assert.equal(localProfile('low').renderer,'native');
  assert.equal(localProfile('low').playMode,'auto');
  assert.equal(localProfile('best').maxHeight,0);
  const c = new EventEmitter();
  let notified = [], installs = [], downloads = 0, failWith = null;
  Object.assign(c,{
    async checkForUpdates() { if (failWith) throw failWith; c.emit('update-available',{version:'1.4.1'}); },
    async downloadUpdate() { downloads++; c.emit('update-downloaded',{version:'1.4.1'}); },
    quitAndInstall(...a) { installs.push(a); }
  });
  const opts = { installed:true, getUpdater:()=>c, notify:s=>notified.push(s) };
  const u = createUpdates(opts);
  assert.equal((await u.check()).phase,'available');
  assert.equal(c.autoDownload,false); assert.equal(c.autoInstallOnAppQuit,false);
  assert.equal(downloads,0); u.install(); assert.equal(installs.length,0);      // nothing before the user's click
  assert.equal((await u.download()).phase,'ready');
  assert.equal(installs.length,0); u.install(); assert.deepEqual(installs,[[true,true]]);
  failWith = Error('net::ERR_INTERNET_DISCONNECTED'); assert.equal((await createUpdates(opts).check()).phase,'offline');
  failWith = Error('HttpError: 404 Not Found'); assert.equal((await createUpdates(opts).check()).phase,'error');
  assert.equal((await createUpdates({ ...opts, installed:false }).check()).phase,'development');
  // public GitHub feed: latest release → latest.yml → installer asset of that tag
  const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
  const provider = new GitHubProvider({ owner:'example', repo:'fixture', provider:'github' }, { allowPrerelease:false, channel:null, currentVersion:{ compare:()=>-1 } },
    { platform:'win32', executor:{ request: async o => route(new URL('https://' + o.hostname + o.path)) }, isUseMultipleRangeRequest:true });
  const installer = 'Kadr-Player-Setup-1.4.1.exe';
  provider.httpRequest = async url => route(url);
  function route(url) {
    if (/releases\.atom$/.test(url.pathname)) return '<feed><entry><link href="https://github.com/example/fixture/releases/tag/v1.4.1"/><title>v1.4.1</title></entry></feed>';
    if (/releases\/latest$/.test(url.pathname)) return JSON.stringify({ tag_name:'v1.4.1' });
    if (/latest\.yml$/.test(url.pathname)) return 'version: 1.4.1\nfiles:\n  - url: ' + installer + '\n    sha512: fixture\n    size: 1\npath: ' + installer + '\nsha512: fixture\n';
    throw Error('unexpected ' + url.href);
  }
  const info = await provider.getLatestVersion();
  assert.equal(info.version,'1.4.1');
  assert.equal(provider.resolveFiles(info)[0].url.href,'https://github.com/example/fixture/releases/download/v1.4.1/' + installer);  console.log('OK: poziomy HLS, jedno źródło, automat, profile lokalne, kontrola pobrania i restartu, publiczny provider GitHub (symulowany transport), brak sieci.');
}
test().catch(e=>{console.error(e);process.exitCode=1;});
