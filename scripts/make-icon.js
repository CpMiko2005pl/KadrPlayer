// Renders build/icon-source.svg with Electron → build/icon.png (256), build/icon-1024.png, build/icon.ico, src/img/logo.svg
// Run with: npm run icon
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const svg = fs.readFileSync(path.join(root, 'build', 'icon-source.svg'), 'utf8');
  fs.mkdirSync(path.join(root, 'src', 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'img', 'logo.svg'), svg);
  const win = new BrowserWindow({ width: 200, height: 200, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
  const render = size => win.webContents.executeJavaScript(`new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size};
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${size}, ${size}); ok(c.toDataURL('image/png')); };
    img.onerror = fail;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
  })`);
  const png = async size => nativeImage.createFromDataURL(await render(size)).toPNG();
  fs.writeFileSync(path.join(root, 'build', 'icon-1024.png'), await png(1024));
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), await png(256));
  const pngs = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) pngs.push({ size, data: await png(size) });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngs));
  console.log('icon written');
  app.quit();
});
