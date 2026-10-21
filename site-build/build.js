'use strict';

// Static build for the VoxBridge site.
//
// The deployment carries this script only; the pages, styles, fonts and images
// are pulled from the repository, which keeps the uploaded payload small and
// the output identical to the commit that triggered the build. When the script
// runs outside Vercel it falls back to the pinned commit below.
//
// Release binaries are mirrored into `public/downloads` so every download is
// served from the site's own origin. GitHub's asset CDN redirects are what made
// mobile downloads stall at 100% on some carriers, so the phone never touches
// it: the page links to /downloads/VoxBridge-android.apk and the CDN streams
// the file with a real Content-Length, Range support and an attachment header.
// If GitHub cannot be reached while building, the manifest simply omits that
// artifact and the page falls back to the release link.

const crypto = require('node:crypto');
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
const REPO = 'sdlksdsf/VoxBridge';
const BASE = `https://raw.githubusercontent.com/${REPO}/${REF}/apps/web/`;

// A local checkout is preferred when it exists (Vercel checks out the whole
// repository because sourceFilesOutsideRootDirectory is on). The HTTP path is
// kept for any build that only has this directory.
const WEB_DIR = path.join(__dirname, '..', 'apps', 'web');

const FILES = [
  '404.html',
  'assets/css/dashboard.css',
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
  'assets/js/dashboard.js',
  'assets/js/icons.js',
  'assets/js/platform.js',
  'assets/js/site.js',
  'dashboard.html',
  'download.html',
  'features.html',
  'index.html',
  'licenses.html',
  'og-card.html',
  'phone-as-microphone.html',
  'privacy.html',
  'robots.txt',
  'security.html',
  'setup.html',
  'sitemap.xml',
  'support.html',
  'terms.html',
];

// Stable, version-free names so the markup never has to change when a release
// is cut. The manifest records the real asset name, byte size and SHA-256.
const ARTIFACTS = [
  { key: 'android', match: /\.apk$/i, stable: 'VoxBridge-android.apk' },
  { key: 'ios', match: /\.ipa$/i, stable: 'VoxBridge-ios.ipa' },
  { key: 'windows', match: /setup.*\.exe$/i, stable: 'VoxBridge-windows-setup.exe' },
  { key: 'portable', match: /portable.*\.zip$/i, stable: 'VoxBridge-windows-portable.zip' },
];

// The Windows binaries are ~80 MB together. They are mirrored too by default,
// but a deployment can opt out with VOXBRIDGE_HOST_WINDOWS=0 without touching
// the phone downloads, which are the ones that used to fail.
const HOST_WINDOWS = process.env.VOXBRIDGE_HOST_WINDOWS !== '0';
const TARGETS = ARTIFACTS.filter((artifact) => HOST_WINDOWS || !/^(windows|portable)$/.test(artifact.key));

async function readPage(file) {
  const local = path.join(WEB_DIR, file);
  if (fs.existsSync(local)) return fs.readFileSync(local);
  const response = await fetch(BASE + file, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Latest release metadata. The REST API is tried first because it also gives
 * the exact byte size. Unauthenticated calls are rate limited per IP and build
 * machines share addresses, so the tag redirect is a full fallback: the tag is
 * all we need to construct the four asset URLs the workflows publish.
 */
async function releaseInfo() {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'voxbridge-site-build' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const release = await response.json();
      return {
        tag: String(release.tag_name || ''),
        version: String(release.tag_name || '').replace(/^v/, ''),
        assets: (release.assets || []).map((asset) => ({
          name: String(asset.name),
          size: Number(asset.size) || 0,
          digest: String(asset.digest || ''),
          url: String(asset.browser_download_url),
        })),
      };
    }
    console.warn(`release API returned HTTP ${response.status}; falling back to the tag redirect`);
  } catch (error) {
    console.warn(`release API unreachable (${error.message}); falling back to the tag redirect`);
  }

  const response = await fetch(`https://github.com/${REPO}/releases/latest`, {
    redirect: 'manual',
    headers: { 'user-agent': 'voxbridge-site-build' },
    signal: AbortSignal.timeout(20_000),
  });
  const location = response.headers.get('location') || '';
  const match = location.match(/\/releases\/tag\/([^/?#]+)/);
  if (!match) return { tag: '', version: '', assets: [] };
  const tag = decodeURIComponent(match[1]);
  const version = tag.replace(/^v/, '');
  const names = {
    android: `VoxBridge-${version}-android.apk`,
    ios: `VoxBridge-${version}-unsigned.ipa`,
    windows: `VoxBridge-Setup-${version}-x64.exe`,
    portable: `VoxBridge-${version}-win64-portable.zip`,
  };
  return {
    tag,
    version,
    assets: Object.values(names).map((name) => ({
      name,
      size: 0,
      url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
    })),
  };
}

async function downloadAsset(asset) {
  const response = await fetch(asset.url, {
    redirect: 'follow',
    headers: { 'user-agent': 'voxbridge-site-build' },
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (asset.size && buffer.length !== asset.size) {
    throw new Error(`expected ${asset.size} bytes, received ${buffer.length}`);
  }
  // Builds re-upload the same asset name, so a download that started before an
  // upload can finish with the previous bytes. The release API tells us the
  // current digest; if it does not match, retry instead of mirroring a file
  // that no longer exists on the release.
  if (asset.digest && asset.digest.startsWith('sha256:')) {
    const actual = sha256(buffer);
    const expected = asset.digest.slice('sha256:'.length);
    if (actual !== expected) {
      throw new Error(`checksum changed during the build (got ${actual.slice(0, 12)}…, expected ${expected.slice(0, 12)}…)`);
    }
  }
  return buffer;
}

/**
 * Build machines share GitHub's rate limits and the CDN occasionally drops a
 * 40 MB transfer mid-stream. One flaky download used to publish a site missing
 * the portable build, so each artifact is retried and a persistent failure
 * fails the build instead — the previous (complete) deployment keeps serving.
 */
async function downloadAssetWithRetry(asset, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadAsset(asset);
    } catch (error) {
      lastError = error;
      console.warn(`downloads: ${asset.name} attempt ${attempt}/${attempts} failed (${error.message})`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

function versionFromName(name) {
  const match = String(name).match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

async function mirrorDownloads(out) {
  const directory = path.join(out, 'downloads');
  fs.mkdirSync(directory, { recursive: true });

  const manifest = {
    version: '',
    tag: '',
    generated: new Date().toISOString(),
    files: {},
  };

  const sources = new Map();
  const localDirectory = process.env.VOXBRIDGE_ASSETS_DIR;

  if (localDirectory && fs.existsSync(localDirectory)) {
    // Local/testing builds: copy whatever matching files are in this folder
    // instead of reaching for GitHub.
    for (const name of fs.readdirSync(localDirectory)) {
      for (const target of TARGETS) {
        if (!sources.has(target.key) && target.match.test(name)) {
          sources.set(target.key, { name, buffer: fs.readFileSync(path.join(localDirectory, name)) });
        }
      }
    }
    console.log(`downloads: using local assets from ${localDirectory}`);
  } else {
    let release = { tag: '', version: '', assets: [] };
    try {
      release = await releaseInfo();
    } catch (error) {
      console.warn(`downloads: could not resolve the latest release (${error.message})`);
    }
    manifest.tag = release.tag;
    manifest.version = release.version;

    await Promise.all(
      TARGETS.map(async (target) => {
        const asset = release.assets.find((candidate) => target.match.test(candidate.name));
        if (!asset) {
          console.warn(`downloads: ${target.key} not present in ${release.tag || 'the latest release'}`);
          return;
        }
        try {
          const buffer = await downloadAssetWithRetry(asset);
          sources.set(target.key, { name: asset.name, buffer });
        } catch (error) {
          throw new Error(`${asset.name} could not be mirrored after 3 attempts (${error.message})`);
        }
      }),
    );
  }

  for (const target of TARGETS) {
    const source = sources.get(target.key);
    if (!source) continue;
    const hash = sha256(source.buffer);
    fs.writeFileSync(path.join(directory, target.stable), source.buffer);
    manifest.files[target.key] = {
      path: `/downloads/${target.stable}`,
      name: source.name,
      size: source.buffer.length,
      sha256: hash,
    };
    if (!manifest.version) manifest.version = versionFromName(source.name);
    console.log(`downloads: ${target.stable} ← ${source.name} (${mb(source.buffer.length)}, sha256 ${hash.slice(0, 12)}…)`);
  }

  const checksums = TARGETS.map((target) => {
    const entry = manifest.files[target.key];
    return entry ? `${entry.sha256}  ${target.stable}` : null;
  }).filter(Boolean);
  // Written even when a mirror failed, so the page's checksum link always
  // resolves; the manifest tells the page which files are actually here.
  fs.writeFileSync(
    path.join(directory, 'SHA256SUMS.txt'),
    checksums.length ? `${checksums.join('\n')}\n` : '# no artifacts were mirrored in this build\n',
  );

  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const mirrored = TARGETS.filter((target) => manifest.files[target.key]).length;
  if (mirrored !== TARGETS.length) {
    throw new Error(`downloads: mirrored ${mirrored}/${TARGETS.length} artifacts — refusing to publish a partial site`);
  }
  if (!manifest.files.android || !manifest.files.ios) {
    console.warn('downloads: the phone builds are missing — the page will fall back to GitHub for them');
  }
  console.log(`downloads: mirrored ${mirrored}/${TARGETS.length} artifacts`);
}

async function main() {
  const out = path.join(__dirname, 'public');
  fs.rmSync(out, { recursive: true, force: true });

  await Promise.all(
    FILES.map(async (file) => {
      const buffer = await readPage(file);
      const target = path.join(out, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
    }),
  );
  console.log(`copied ${FILES.length} files from ${REF.slice(0, 7)}`);

  await mirrorDownloads(out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
