// electron-builder afterPack hook: puts the app icon and version info into the exe with rcedit
// (signAndEditExecutable is off, so electron-builder doesn't need its winCodeSign download)
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  const info = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${info.productFilename}.exe`);
  const root = path.join(__dirname, '..');
  execFileSync(path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'), [exe,
    '--set-icon', path.join(root, 'build', 'icon.ico'),
    '--set-version-string', 'ProductName', info.productName,
    '--set-version-string', 'FileDescription', 'Kadr Player — odtwarzacz wideo',
    '--set-version-string', 'CompanyName', 'Kadr Player (sponsorzy: ProZlecenie.pl, CyberScope.pl)',
    '--set-version-string', 'LegalCopyright', 'Freeware',
    '--set-version-string', 'OriginalFilename', `${info.productFilename}.exe`,
    '--set-file-version', info.version, '--set-product-version', info.version]);
};
