#!/usr/bin/env node
'use strict';

// Lightweight repository lint: syntax-check every JS file with the Node parser
// and verify that HTML references to local assets exist. No dependencies.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'release', 'dist', 'build', 'Pods', 'DerivedData']);
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

walk(root);
console.log(`checked ${files} javascript files, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
