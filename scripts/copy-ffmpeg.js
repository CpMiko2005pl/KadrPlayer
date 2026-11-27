// Puts ffmpeg.exe + ffprobe.exe into vendor/ffmpeg (bundled into the installer as resources/ffmpeg).
// Source: KADR_FFMPEG_DIR, else the folder of the ffmpeg found on PATH (e.g. winget Gyan.FFmpeg full build).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'vendor', 'ffmpeg');
let src = process.env.KADR_FFMPEG_DIR;
if (!src) {
  try { src = path.dirname(execFileSync('where', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()); } catch {}
}
if (!src || !fs.existsSync(path.join(src, 'ffmpeg.exe'))) {
  console.error('ffmpeg.exe not found — set KADR_FFMPEG_DIR to a folder with ffmpeg.exe and ffprobe.exe');
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });
for (const f of ['ffmpeg.exe', 'ffprobe.exe']) {
  const a = path.join(src, f), b = path.join(dest, f);
  const sa = fs.statSync(a);
  if (fs.existsSync(b) && fs.statSync(b).size === sa.size) continue;
  fs.copyFileSync(a, b);
  console.log('copied', f, (sa.size / 1048576).toFixed(0), 'MB');
}
const version = execFileSync(path.join(dest, 'ffmpeg.exe'), ['-hide_banner', '-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
fs.writeFileSync(path.join(dest, 'FFMPEG-LICENSE.txt'),
  `Kadr bundles FFmpeg (${version}).\r\n` +
  'FFmpeg is free software licensed under the GNU General Public License version 3 (this build includes GPL components such as libx264 and libx265).\r\n' +
  'Build: https://www.gyan.dev/ffmpeg/builds/  Source code: https://ffmpeg.org/download.html and https://github.com/FFmpeg/FFmpeg\r\n' +
  'License text: https://www.gnu.org/licenses/gpl-3.0.txt\r\n');
console.log('vendor/ffmpeg ready:', version);
