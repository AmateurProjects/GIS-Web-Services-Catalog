#!/usr/bin/env node
'use strict';

/**
 * health-check.js
 *
 * Scheduled health check for all ArcGIS REST services in catalog.json.
 * Writes results to data/health-history.json and optionally opens GitHub Issues
 * when services are down for consecutive runs.
 *
 * Usage:
 *   node scripts/health-check.js                    # dry-run
 *   node scripts/health-check.js --write            # write health-history.json
 *   node scripts/health-check.js --write --issues   # also create GitHub issues
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'health-history.json');
const TIMEOUT_MS = 15000;
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const doWrite = args.includes('--write');
const doIssues = args.includes('--issues');

// ── HTTP ──

function fetchUrl(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const start = Date.now();
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, timeout).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const elapsed = Date.now() - start;
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, json, elapsed });
        } catch (_) {
          resolve({ status: res.statusCode, json: null, elapsed, raw: data.slice(0, 200) });
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Service Health Check ──

async function checkService(url) {
  const testUrl = url.includes('?') ? url : `${url}?f=pjson`;

  try {
    const { status, json, elapsed } = await fetchUrl(testUrl, TIMEOUT_MS);

    if (status < 200 || status >= 400) {
      return { status: 'down', httpStatus: status, detail: `HTTP ${status}`, responseTime: elapsed };
    }

    // Check for ArcGIS error responses
    if (json && json.error) {
      return {
        status: 'error',
        httpStatus: status,
        detail: `ArcGIS error ${json.error.code}: ${json.error.message || ''}`,
        responseTime: elapsed,
      };
    }

    // Check if it returns valid service metadata
    if (json && (json.layers || json.type || json.currentVersion || json.name)) {
      return { status: 'healthy', httpStatus: status, detail: 'Serving data', responseTime: elapsed };
    }

    // Try a simple query
    try {
      const queryUrl = `${url}/query?where=1%3D1&returnCountOnly=true&f=json`;
      const qr = await fetchUrl(queryUrl, TIMEOUT_MS);
      if (qr.json && typeof qr.json.count === 'number') {
        return { status: 'healthy', httpStatus: 200, detail: `Serving data (${qr.json.count} features)`, responseTime: elapsed };
      }
    } catch (_) {}

    return { status: 'degraded', httpStatus: status, detail: 'Response received but could not verify data', responseTime: elapsed };

  } catch (e) {
    return { status: 'down', httpStatus: 0, detail: e.message, responseTime: TIMEOUT_MS };
  }
}

// ── Main ──

async function main() {
  console.log('=== Health Check ===');
  console.log(`  Mode: ${doWrite ? 'WRITE' : 'DRY-RUN'}${doIssues ? ' +ISSUES' : ''}\n`);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const datasets = catalog.datasets || [];

  // Build unique service URLs
  const serviceMap = new Map();
  datasets.forEach(d => {
    const url = d.public_web_service;
    if (!url) return;
    const key = d._parent_service || url;
    if (!serviceMap.has(key)) {
      serviceMap.set(key, { url: key, datasets: [] });
    }
    serviceMap.get(key).datasets.push(d.id);
  });

  const services = [...serviceMap.values()];
  console.log(`  ${services.length} unique service endpoints to check\n`);

  // Load history
  let history = { runs: [] };
  if (fs.existsSync(HISTORY_PATH)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch (_) {}
  }

  // Check all services
  const results = [];
  let idx = 0;
  let healthyCount = 0, downCount = 0, errorCount = 0, degradedCount = 0;

  async function worker() {
    while (idx < services.length) {
      const i = idx++;
      const svc = services[i];
      const result = await checkService(svc.url);
      results.push({ url: svc.url, datasets: svc.datasets, ...result });

      const icon = result.status === 'healthy' ? '✓' : result.status === 'down' ? '✗' : '⚠';
      console.log(`  [${i + 1}/${services.length}] ${icon} ${result.status.toUpperCase()} (${result.responseTime}ms) ${svc.url.slice(0, 70)}`);

      if (result.status === 'healthy') healthyCount++;
      else if (result.status === 'down') downCount++;
      else if (result.status === 'error') errorCount++;
      else degradedCount++;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Build run record
  const run = {
    timestamp: new Date().toISOString(),
    summary: {
      total: services.length,
      healthy: healthyCount,
      down: downCount,
      error: errorCount,
      degraded: degradedCount,
    },
    services: results.map(r => ({
      url: r.url,
      status: r.status,
      httpStatus: r.httpStatus,
      detail: r.detail,
      responseTime: r.responseTime,
      datasets: r.datasets,
    })),
  };

  // Keep last 30 runs
  history.runs.push(run);
  if (history.runs.length > 30) {
    history.runs = history.runs.slice(-30);
  }

  // Stats
  console.log(`\n=== Summary ===`);
  console.log(`  Healthy:  ${healthyCount}`);
  console.log(`  Down:     ${downCount}`);
  console.log(`  Error:    ${errorCount}`);
  console.log(`  Degraded: ${degradedCount}`);
  console.log(`  Total:    ${services.length}`);

  // Detect services down on consecutive runs (>= 2 runs)
  const consecutiveDown = [];
  if (history.runs.length >= 2) {
    const prevRun = history.runs[history.runs.length - 2];
    const prevDown = new Set(prevRun.services.filter(s => s.status === 'down' || s.status === 'error').map(s => s.url));

    results.forEach(r => {
      if ((r.status === 'down' || r.status === 'error') && prevDown.has(r.url)) {
        consecutiveDown.push(r);
      }
    });

    if (consecutiveDown.length > 0) {
      console.log(`\n⚠ ${consecutiveDown.length} service(s) down on consecutive runs:`);
      consecutiveDown.forEach(r => {
        console.log(`    ${r.url}`);
        console.log(`      ${r.detail} — Datasets: ${r.datasets.join(', ')}`);
      });
    }
  }

  if (doWrite) {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
    console.log(`\n✅ Wrote ${HISTORY_PATH}`);
  } else {
    console.log('\nDry run — pass --write to save.');
  }

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const output = [
      `healthy=${healthyCount}`,
      `down=${downCount}`,
      `error=${errorCount}`,
      `total=${services.length}`,
      `consecutive_down=${consecutiveDown.length}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, output + '\n');
  }

  // Exit code: fail if any services are consecutively down
  if (consecutiveDown.length > 0 && doIssues) {
    console.log(`\n⚠ Exiting with code 1 (${consecutiveDown.length} consecutive failures)`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
