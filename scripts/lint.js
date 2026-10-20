#!/usr/bin/env node
'use strict';

// Lightweight repository lint: syntax-check every JS file with the Node parser
// and verify that HTML references to local assets exist. No dependencies.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'release', 'dist', 'build', 'public', 'Pods', 'DerivedData']);
let files = 0;
let failures = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) check(full);
  }
}

function check(file) {
  files += 1;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures += 1;
    console.error(`syntax: ${path.relative(root, file)}`);
    console.error(String(error.stderr || error.message).trim());
  }
}

function checkSite() {
  const site = path.join(root, 'apps', 'web');
  if (!fs.existsSync(site)) return;
  const pages = fs.readdirSync(site).filter((name) => name.endsWith('.html'));
  // Release binaries are mirrored by site-build/build.js at deploy time, so
  // they are not part of the checkout. Trust the stable names declared there.
  const generated = new Set(['/downloads/SHA256SUMS.txt', '/downloads/manifest.json']);
  const buildFile = path.join(root, 'site-build', 'build.js');
  if (fs.existsSync(buildFile)) {
    for (const match of fs.readFileSync(buildFile, 'utf8').matchAll(/stable:\s*'([^']+)'/g)) {
      generated.add(`/downloads/${match[1]}`);
    }
  }
  for (const name of pages) {
    const file = path.join(site, name);
    const html = fs.readFileSync(file, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map((m) => m[1]);
    for (const ref of new Set(refs)) {
      if (generated.has(ref)) continue;
      if (ref === '/' || /\.(html|xml|txt)$/.test(ref)) {
        const local = path.join(site, ref === '/' ? 'index.html' : ref);
        if (!fs.existsSync(local)) {
          failures += 1;
          console.error(`missing page: ${name} -> ${ref}`);
        }
        continue;
      }
      const local = path.join(site, decodeURIComponent(ref));
      if (!fs.existsSync(local)) {
        failures += 1;
        console.error(`missing asset: ${name} -> ${ref}`);
      }
    }
  }
  console.log(`checked ${pages.length} website pages`);
}

walk(root);
checkSite();
console.log(`checked ${files} javascript files, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
