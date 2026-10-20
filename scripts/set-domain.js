#!/usr/bin/env node
/**
 * Point the site at a new host.
 *
 * The canonical URL appears in every page head, the sitemap, robots.txt, the
 * JSON-LD graph, the README and the smoke workflow. Miss one and Google sees
 * two sites. This rewrites them all and refuses to finish if a stale reference
 * survives.
 *
 *   node scripts/set-domain.js https://voxbridge.is-a.dev          # dry run
 *   node scripts/set-domain.js https://voxbridge.is-a.dev --apply
 *
 * The old host is kept as a second alias in Vercel, so links already shared
 * keep working; only the canonical references move.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * Read the host the site currently advertises instead of hard-coding it.
 * The constant used to go stale after every move, which made the stale-reference
 * check silently useless; the canonical link cannot drift from the pages.
 */
function currentHost() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8');
    const match = html.match(/<link[^>]+rel="canonical"[^>]+href="https:\/\/([^/"]+)/i)
      || html.match(/<link[^>]+href="https:\/\/([^/"]+)[^>]+rel="canonical"/i);
    if (match) return match[1];
  } catch { /* fall through */ }
  throw new Error('could not read the canonical address from apps/web/index.html');
}

const OLD_HOST = currentHost();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'public', '.vercel', '.next']);
const EXTENSIONS = new Set(['.html', '.xml', '.txt', '.js', '.json', '.md', '.yml', '.yaml']);

function parseTarget(argv) {
  const value = argv.find((arg) => !arg.startsWith('-'));
  if (!value) {
    console.error('usage: node scripts/set-domain.js https://your.domain [--apply]');
    process.exit(2);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    console.error(`not a URL: ${value}`);
    process.exit(2);
  }
  if (url.protocol !== 'https:') {
    console.error('use an https:// address — the site is HTTPS-only');
    process.exit(2);
  }
  if (url.hostname === OLD_HOST) {
    console.error('that is already the current host');
    process.exit(2);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    console.error('give the bare origin, e.g. https://voxbridge.is-a.dev');
    process.exit(2);
  }
  return { host: url.hostname, origin: url.origin };
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (path.join(dir, entry.name) === __filename) continue; // this file names the old host on purpose
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, files);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function main() {
  const apply = process.argv.includes('--apply');
  const { host, origin } = parseTarget(process.argv.slice(2));
  const files = walk(ROOT);

  const changed = [];
  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    if (!before.includes(OLD_HOST)) continue;
    // Host first (covers https://, protocol-relative and bare mentions), then
    // repair the doubled protocol a blind replace would leave behind.
    const after = before
      .split(`https://${OLD_HOST}`)
      .join(origin)
      .split(OLD_HOST)
      .join(host);
    const count = before.split(OLD_HOST).length - 1;
    changed.push({ file: path.relative(ROOT, file), count });
    if (apply) fs.writeFileSync(file, after);
  }

  for (const item of changed) console.log(`${apply ? 'rewrote' : 'would rewrite'} ${item.file} (${item.count})`);
  console.log(`\n${changed.length} file(s), ${changed.reduce((sum, item) => sum + item.count, 0)} reference(s) -> ${host}`);

  if (!apply) {
    console.log('\ndry run — nothing written. Add --apply when the new domain answers on HTTPS.');
    return;
  }

  // A stale reference is worse than a failed run: it splits the canonical.
  const stale = [];
  for (const file of walk(ROOT)) {
    if (fs.readFileSync(file, 'utf8').includes(OLD_HOST)) stale.push(path.relative(ROOT, file));
  }
  if (stale.length) {
    console.error(`\nstale references remain in:\n${stale.join('\n')}`);
    process.exit(1);
  }
  console.log('\nno stale references. Next: redeploy, then verify the canonical on the live site.');
}

main();
