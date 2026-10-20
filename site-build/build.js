'use strict';

// Static build for the VoxBridge site.
//
// The deployment carries this script only; the pages, styles, fonts and images
// are pulled from the repository at a pinned commit, which keeps every build
// reproducible and the uploaded payload small. Bump SHA when the site changes.

const fs = require('node:fs');
const path = require('node:path');

const SHA = '2c8ca1098ca6fb36a3605cf0ababc8c1fa57db7d';
const BASE = `https://raw.githubusercontent.com/sdlksdsf/Virtual-Mic/${SHA}/apps/web/`;

const FILES = [
  '404.html',
  'assets/css/site.css',
  'assets/fonts/instrument-serif-400-italic.woff2',
  'assets/fonts/instrument-serif-400.woff2',
  'assets/fonts/inter-tight-400.woff2',
  'assets/fonts/inter-tight-500.woff2',
  'assets/fonts/inter-tight-600.woff2',
  'assets/fonts/jetbrains-mono-400.woff2',
  'assets/fonts/jetbrains-mono-500.woff2',
  'assets/img/app-live-dark.png',
  'assets/img/app-live.png',
  'assets/img/app-pair.png',
  'assets/img/app-settings-dark.png',
  'assets/img/app-settings.png',
  'assets/img/app-studio.png',
  'assets/img/apple-touch-icon.png',
  'assets/img/favicon.svg',
  'assets/img/mark.svg',
  'assets/img/og.png',
  'assets/img/phone-pair-dark.png',
  'assets/img/phone-pair.png',
  'assets/js/config.js',
  'assets/js/icons.js',
  'assets/js/site.js',
  'download.html',
  'features.html',
  'index.html',
  'licenses.html',
  'og-card.html',
  'privacy.html',
  'robots.txt',
  'security.html',
  'setup.html',
  'sitemap.xml',
  'support.html',
  'terms.html',
];

async function main() {
  const out = path.join(__dirname, 'public');
  fs.rmSync(out, { recursive: true, force: true });
  await Promise.all(
    FILES.map(async (file) => {
      const response = await fetch(BASE + file);
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const target = path.join(out, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
    }),
  );
  console.log(`copied ${FILES.length} files from ${SHA.slice(0, 7)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
