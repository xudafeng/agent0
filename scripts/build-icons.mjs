import { app, BrowserWindow, nativeImage } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../desktop/assets/', import.meta.url));

async function buildIcons() {
  try {
    if (process.platform !== 'darwin') throw new Error('Generate application icons on macOS (requires iconutil).');
    await app.whenReady();
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await window.loadURL('about:blank');
    const svg = await readFile(path.join(assets, 'icon.svg'), 'utf8');
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const png = await window.webContents.executeJavaScript(`
      (async () => {
        const image = new Image();
        image.src = ${JSON.stringify(source)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
      })()
    `);
    const image = nativeImage.createFromDataURL(png);
    await writeFile(path.join(assets, 'icon.png'), image.toPNG());
    const directory = await mkdtemp(path.join(tmpdir(), 'agent0-icons-'));
    const iconset = path.join(directory, 'icon.iconset');
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        await writeFile(path.join(iconset, name), image.resize({ width: size * scale, height: size * scale, quality: 'best' }).toPNG());
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')]);
    console.log('Generated desktop/assets/icon.png and icon.icns');
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

void buildIcons();
