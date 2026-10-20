'use strict';

// Static build for the VoxBridge site.
//
// The deployment carries this script only; the pages, styles, fonts and images
// are pulled from the repository, which keeps the uploaded payload small and
// the output identical to the commit that triggered the build. When the script
// runs outside Vercel it falls back to the pinned commit below.

const fs = require('node:fs');
const path = require('node:path');

// Production builds on Vercel always fetch the commit that triggered the
// deployment, so the site can never drift behind the repository. Outside
// Vercel (a local `node build.js`) the tip of main is used instead of a frozen
// sha, which saves remembering to bump a constant after every site change.
const PINNED = 'main';
const REF = process.env.VERCEL_GIT_COMMIT_SHA || PINNED;

if (!/^[0-9a-zA-Z._/-]{1,100}$/.test(REF)) {
  throw new Error(`unexpected git ref: ${REF}`);
}
const BASE = `https://raw.githubusercontent.com/sdlksdsf/Virtual-Mic/${REF}/apps/web/`;

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
  'assets/img/app-live-dark.webp',
  'assets/img/app-live.webp',
  'assets/img/app-pair.webp',
  'assets/img/app-settings-dark.webp',
  'assets/img/app-studio.webp',
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
  console.log(`copied ${FILES.length} files from ${REF.slice(0, 7)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
