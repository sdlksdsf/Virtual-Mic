#!/usr/bin/env node
/**
 * Probe the live site and record one health row.
 *
 *   node scripts/health-probe.js            # record and print a summary
 *
 * Used by the scheduled Site health workflow and by the release smoke test, so
 * the dashboard shows a continuous history instead of a gap whenever one of
 * the two runs. Failures are recorded as failures — the job itself only fails
 * if the row could not be written, because a red build for a known outage adds
 * nothing to the dashboard.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'apps', 'web', 'assets', 'js', 'config.js');
const BASE = process.env.VOXBRIDGE_PROBE_BASE || 'https://voxbridge-mic.vercel.app';

const TARGETS = [
  { name: 'home', method: 'GET', path: '/' },
  { name: 'download', method: 'GET', path: '/download' },
  { name: 'dashboard', method: 'GET', path: '/dashboard' },
  { name: 'manifest', method: 'GET', path: '/downloads/manifest.json' },
  { name: 'apk', method: 'HEAD', path: '/downloads/VoxBridge-android.apk' },
  { name: 'setup', method: 'HEAD', path: '/downloads/VoxBridge-windows-setup.exe' },
];

function configValue(pattern) {
  const source = fs.readFileSync(CONFIG, 'utf8');
  const match = source.match(pattern);
  if (!match) throw new Error(`could not read ${pattern} from apps/web/assets/js/config.js`);
  return match[1];
}

async function probe(target) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}${target.path}?probe=${Date.now()}`, {
      method: target.method,
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
      headers: { 'user-agent': 'voxbridge-health-probe' },
    });
    // Drain the body so the connection closes cleanly for GETs.
    if (target.method === 'GET') await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - started), error: error.message };
  }
}

async function main() {
  const url = configValue(/supabaseUrl:\s*'([^']+)'/);
  const key = configValue(/supabaseAnonKey:\s*'([^']+)'/);

  const results = await Promise.all(TARGETS.map((target) => probe(target)));
  const checks = {};
  TARGETS.forEach((target, index) => {
    checks[target.name] = results[index];
  });

  const ok = results.every((result) => result.ok);
  const home = checks.home;
  const latency = home.ok ? home.ms : Math.max(...results.map((result) => result.ms));
  const payload = {
    ok,
    latency_ms: latency,
    checks,
    source: 'github-actions',
  };

  for (const target of TARGETS) {
    const result = checks[target.name];
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${target.path} ${result.status} ${result.ms} ms`);
  }

  const response = await fetch(`${url}/rest/v1/health_checks`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`could not record the health check (HTTP ${response.status}): ${detail}`);
    process.exit(1);
  }
  console.log(`recorded: ${ok ? 'all endpoints healthy' : 'degraded'} (${latency} ms)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
