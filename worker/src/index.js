// ================================================================
// Cloudflare Worker — GIS Catalog Scanner (Freshness + Health)
// ================================================================
// Ports scripts/generate-freshness.js and js/url-check.js to a
// Worker + R2 architecture. No CORS issues since checks run server-side.
//
// R2 keys:
//   freshness.json           — latest freshness scan results
//   freshness-previous.json  — previous freshness scan (for record count delta)
//   health.json              — latest service health check results
//   health-task.json         — in-progress health scan state
//   freshness-task.json      — in-progress freshness scan state
//
// Routes:
//   GET  /freshness.json      → serve from R2
//   POST /freshness/refresh   → run freshness scan, store in R2
//   GET  /freshness/status    → last-generated timestamp
//   GET  /health.json         → serve from R2
//   POST /health/refresh      → run health scan, store in R2
//   GET  /health/status       → last-generated timestamp
//   Cron trigger              → runs batched scans (see below)
//
// Batch Processing Strategy:
//   Cloudflare Workers have a 50-subrequest limit per invocation (free plan).
//   To handle large catalogs, scans are split into batches:
//   - Health: 20 services per batch (~20 fetches)
//   - Freshness: 5 datasets per batch (~20 fetches)
//
//   Cron runs every minute from 6:00-6:30 UTC. Each invocation:
//   1. Checks for incomplete tasks (task file in R2)
//   2. If found, continues from the last offset
//   3. If not, starts a fresh scan (if data is stale)
//
//   This allows processing 150+ datasets within Cloudflare limits.
// ================================================================

const R2_KEY = 'freshness.json';
const R2_KEY_PREV = 'freshness-previous.json';
const R2_KEY_HEALTH = 'health.json';
const R2_KEY_HEALTH_TASK = 'health-task.json';
const R2_KEY_FRESHNESS_TASK = 'freshness-task.json';
const R2_KEY_OVERRIDES = 'catalog-overrides.json';
const TIMEOUT_MS = 12_000;
const HEALTH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2_000;

// ── Batch-and-chain settings ──
// Cloudflare Workers free plan: 50 outbound fetch() per invocation.
// We split scans into small batches to stay under this limit.
// Health: 1 fetch per service → batch of 20 = ~22 subrequests.
// Freshness: ~4 fetches per dataset → batch of 5 = ~22 subrequests.
const HEALTH_BATCH_SIZE = 20;
const FRESHNESS_BATCH_SIZE = 5;

// ── CORS headers applied to every response ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ================================================================
// Entry point
// ================================================================

export default {
  async fetch(request, env, ctx) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // ── GET /freshness.json ──
    if (request.method === 'GET' && (path === '/freshness.json' || path === '/freshness')) {
      return serveFreshness(env);
    }

    // ── GET /freshness/status ──
    if (request.method === 'GET' && path === '/freshness/status') {
      return serveStatus(env, R2_KEY);
    }

    // ── GET /health.json ──
    if (request.method === 'GET' && (path === '/health.json' || path === '/health')) {
      return serveR2Json(env, R2_KEY_HEALTH);
    }

    // ── GET /health/status ──
    if (request.method === 'GET' && path === '/health/status') {
      return serveStatus(env, R2_KEY_HEALTH);
    }

    // ── POST /freshness/refresh ──
    if (request.method === 'POST' && path === '/freshness/refresh') {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (offset === 0 && env.REFRESH_TOKEN) {
        const auth = request.headers.get('Authorization') || '';
        if (auth !== `Bearer ${env.REFRESH_TOKEN}`) {
          return corsJson({ error: 'Unauthorized' }, 401);
        }
      }
      // Run inline — browser drives the batch chain
      const result = await runScan(env, offset);
      return corsJson(result);
    }

    // ── POST /health/refresh ──
    if (request.method === 'POST' && path === '/health/refresh') {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (offset === 0 && env.REFRESH_TOKEN) {
        const auth = request.headers.get('Authorization') || '';
        if (auth !== `Bearer ${env.REFRESH_TOKEN}`) {
          return corsJson({ error: 'Unauthorized' }, 401);
        }
      }
      // Run inline — browser drives the batch chain
      const result = await runHealthScan(env, offset);
      return corsJson(result);
    }

    // ── GET /catalog/overrides.json ──
    if (request.method === 'GET' && (path === '/catalog/overrides.json' || path === '/catalog/overrides')) {
      return serveR2Json(env, R2_KEY_OVERRIDES);
    }

    // ── PATCH /catalog/dataset/:id ──
    const patchMatch = path.match(/^\/catalog\/dataset\/(.+)$/);
    if (request.method === 'PATCH' && patchMatch) {
      return handleDatasetPatch(request, env, decodeURIComponent(patchMatch[1]));
    }

    return corsJson({ error: 'Not found' }, 404);
  },

  // ── Cron Trigger — processes batches across multiple invocations ──
  // Runs every minute during the scan window (6:00-6:30 UTC).
  // Each invocation processes one batch, staying under Cloudflare's
  // 50-subrequest limit. Incomplete tasks are continued on subsequent triggers.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledBatch(env));
  },
};

// ================================================================
// Scheduled batch runner — works within Cloudflare subrequest limits
// ================================================================
// Processes ONE batch per cron invocation. Each batch stays under
// 50 subrequests (HEALTH_BATCH_SIZE=20, FRESHNESS_BATCH_SIZE=5×~4=20).
// Requires multiple cron triggers (e.g., every minute from 6:00-6:30).

async function runScheduledBatch(env) {
  // Check for incomplete health task first
  const healthTask = await env.BUCKET.get(R2_KEY_HEALTH_TASK);
  if (healthTask) {
    const task = JSON.parse(await healthTask.text());
    const offset = task.results?.length || 0;
    console.log(`Continuing health scan from offset ${offset}`);
    await runHealthScan(env, offset);
    return;
  }

  // Check for incomplete freshness task
  const freshnessTask = await env.BUCKET.get(R2_KEY_FRESHNESS_TASK);
  if (freshnessTask) {
    const task = JSON.parse(await freshnessTask.text());
    const offset = task.results?.length || 0;
    console.log(`Continuing freshness scan from offset ${offset}`);
    await runScan(env, offset);
    return;
  }

  // No incomplete tasks — check if we should start fresh scans
  // Only start new scans if existing data is stale (>20 hours old)
  const healthObj = await env.BUCKET.get(R2_KEY_HEALTH);
  const freshnessObj = await env.BUCKET.get(R2_KEY);
  
  const now = Date.now();
  const STALE_THRESHOLD_MS = 20 * 60 * 60 * 1000; // 20 hours
  
  let healthStale = true;
  let freshnessStale = true;
  
  if (healthObj) {
    try {
      const data = JSON.parse(await healthObj.text());
      if (data.generated && data._scanComplete !== false) {
        healthStale = (now - new Date(data.generated).getTime()) > STALE_THRESHOLD_MS;
      }
    } catch (_) {}
  }
  
  if (freshnessObj) {
    try {
      const data = JSON.parse(await freshnessObj.text());
      if (data.generated && data._scanComplete !== false) {
        freshnessStale = (now - new Date(data.generated).getTime()) > STALE_THRESHOLD_MS;
      }
    } catch (_) {}
  }

  // Start whichever scan is stale (health first, then freshness)
  if (healthStale) {
    console.log('Starting new health scan (data stale or missing)');
    await runHealthScan(env, 0);
  } else if (freshnessStale) {
    console.log('Starting new freshness scan (data stale or missing)');
    await runScan(env, 0);
  } else {
    console.log('Scheduled scan skipped — data is fresh');
  }
}

// ================================================================
// Serve any R2 JSON key
// ================================================================

async function serveR2Json(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) {
    return corsJson({ error: `No data available yet for ${key}. Trigger a refresh first.` }, 404);
  }
  const data = await obj.text();
  return new Response(data, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS },
  });
}

// ================================================================
// Serve freshness.json from R2
// ================================================================

async function serveFreshness(env) {
  return serveR2Json(env, R2_KEY);
}

// ================================================================
// Return last-generated timestamp for any R2 key
// ================================================================

async function serveStatus(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) {
    return corsJson({ exists: false, generated: null });
  }
  try {
    const data = JSON.parse(await obj.text());
    return corsJson({ exists: true, generated: data.generated || null, totalChecked: data.totalChecked || 0, count: data.services?.length || data.datasets?.length || 0 });
  } catch (_) {
    return corsJson({ exists: true, generated: null });
  }
}

// ================================================================
// Handle PATCH /catalog/dataset/:id — admin inline edits
// ================================================================
// Stores per-dataset field overrides in R2 (catalog-overrides.json).
// Body: { fields: { key: value, ... } }
// Auth: Bearer <ADMIN_TOKEN> (env variable)
// The overrides file is a simple map: { datasetId: { field: value, ... }, ... }
// The frontend merges these on top of the base catalog.json at load time.

async function handleDatasetPatch(request, env, datasetId) {
  // Auth check — ADMIN_TOKEN is required for writes
  const token = env.ADMIN_TOKEN;
  if (!token) {
    return corsJson({ error: 'Admin edits not configured. Set ADMIN_TOKEN env var on the Worker.' }, 501);
  }
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${token}`) {
    return corsJson({ error: 'Unauthorized' }, 401);
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return corsJson({ error: 'Invalid JSON body' }, 400);
  }

  const fields = body?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return corsJson({ error: 'Body must contain { fields: { key: value, ... } }' }, 400);
  }

  // Load existing overrides
  let overrides = {};
  try {
    const obj = await env.BUCKET.get(R2_KEY_OVERRIDES);
    if (obj) overrides = JSON.parse(await obj.text());
  } catch (_) {}

  // Merge — shallow merge per dataset (new fields overwrite, null removes)
  const existing = overrides[datasetId] || {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') {
      delete existing[k];
    } else {
      existing[k] = v;
    }
  }

  // Remove dataset entry entirely if no overrides remain
  if (Object.keys(existing).length === 0) {
    delete overrides[datasetId];
  } else {
    overrides[datasetId] = existing;
  }

  // Write back
  await env.BUCKET.put(R2_KEY_OVERRIDES, JSON.stringify(overrides, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return corsJson({
    ok: true,
    datasetId,
    overrides: overrides[datasetId] || {},
    totalOverriddenDatasets: Object.keys(overrides).length,
  });
}

// ================================================================
// Run a full freshness scan
// ================================================================

async function runScan(env, offset = 0) {
  let task;

  if (offset === 0) {
    const catalogUrl = `${(env.CATALOG_BASE_URL || '').replace(/\/+$/, '')}/data/catalog.json`;
    let catalog;
    try {
      const resp = await fetch(catalogUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      catalog = await resp.json();
    } catch (e) {
      console.error('Freshness scan: failed to fetch catalog.json:', e);
      return { error: 'Failed to fetch catalog', done: true };
    }

    const datasets = catalog.datasets || [];

    let existing = {};
    try {
      const prev = await env.BUCKET.get(R2_KEY);
      if (prev) {
        const data = JSON.parse(await prev.text());
        (data.datasets || []).forEach(d => { existing[d.datasetId] = d; });
      }
    } catch (_) {}

    const toProcess = datasets.filter(ds => {
      if (!ds.public_web_service) return false;
      if (!/\/rest\/services\//i.test(ds.public_web_service)) return false;
      return true;
    });

    const allDatasetIds = datasets.map(ds => ds.id);

    console.log(`Freshness scan: ${toProcess.length} datasets to check in batches of ${FRESHNESS_BATCH_SIZE}`);

    await env.BUCKET.delete(R2_KEY_FRESHNESS_TASK);
    task = { toProcess, existing, allDatasetIds, results: [] };
  } else {
    const obj = await env.BUCKET.get(R2_KEY_FRESHNESS_TASK);
    if (!obj) { return { error: 'No task found', done: true }; }
    task = JSON.parse(await obj.text());
  }

  const batch = task.toProcess.slice(offset, offset + FRESHNESS_BATCH_SIZE);
  console.log(`Freshness scan batch: offset=${offset}, batchSize=${batch.length}, total=${task.toProcess.length}`);

  // Process freshness datasets in parallel (each dataset does multiple fetches internally)
  const batchResults = await Promise.allSettled(
    batch.map(async (ds) => {
      const stored = task.existing[ds.id] || task.existing[ds.datasetId];
      const storedCount = stored?.recordCount ?? null;
      const result = await processDataset(ds, storedCount, env);
      return { ds, result };
    })
  );
  for (let i = 0; i < batchResults.length; i++) {
    const r = batchResults[i];
    if (r.status === 'fulfilled') {
      if (r.value.result) task.results.push(r.value.result);
    } else {
      const ds = batch[i];
      console.log(`  Error processing ${ds.id}: ${r.reason?.message}`);
      task.results.push({
        datasetId: ds.id, lastUpdated: null, signal: 'none',
        confidence: 'none', details: r.reason?.message || 'Unknown error', signals: [], recordCount: null,
      });
    }
  }

  const nextOffset = offset + FRESHNESS_BATCH_SIZE;
  const done = nextOffset >= task.toProcess.length;

  if (!done) {
    await env.BUCKET.put(R2_KEY_FRESHNESS_TASK, JSON.stringify(task));
  } else {
    // Finalize: merge with existing data for datasets we didn't re-check
    task.allDatasetIds.forEach(id => {
      if (!task.results.find(r => r.datasetId === id) && task.existing[id]) {
        task.results.push(task.existing[id]);
      }
    });
  }

  const output = {
    generated: new Date().toISOString(),
    totalChecked: task.toProcess.length,
    datasets: task.results,
    _scanComplete: done,
  };

  // Archive previous on first batch only
  if (offset === 0) {
    try {
      const prev = await env.BUCKET.get(R2_KEY);
      if (prev) await env.BUCKET.put(R2_KEY_PREV, prev.body);
    } catch (_) {}
  }

  await env.BUCKET.put(R2_KEY, JSON.stringify(output, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  if (done) {
    await env.BUCKET.delete(R2_KEY_FRESHNESS_TASK);
    const confCounts = { high: 0, medium: 0, low: 0, none: 0 };
    task.results.forEach(r => { confCounts[r.confidence] = (confCounts[r.confidence] || 0) + 1; });
    console.log(`Freshness scan complete: high=${confCounts.high} medium=${confCounts.medium} low=${confCounts.low} none=${confCounts.none}`);
  }

  return {
    done,
    offset,
    nextOffset: done ? null : nextOffset,
    total: task.toProcess.length,
    processed: task.results.length,
    batchSize: batch.length,
  };
}

// ================================================================
// Run a full health scan (mirrors js/url-check.js, server-side)
// ================================================================

async function runHealthScan(env, offset = 0) {
  let task;

  if (offset === 0) {
    // ── First batch: fetch catalog and build service list ──
    const catalogUrl = `${(env.CATALOG_BASE_URL || '').replace(/\/+$/, '')}/data/catalog.json`;
    let catalog;
    try {
      const resp = await fetch(catalogUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      catalog = await resp.json();
    } catch (e) {
      console.error('Health scan: failed to fetch catalog.json:', e);
      return { error: 'Failed to fetch catalog', done: true };
    }

    const datasets = catalog.datasets || [];
    const serviceMap = new Map();
    datasets.forEach(d => {
      const url = d.public_web_service;
      if (!url) return;
      const key = d._parent_service || url;
      if (!serviceMap.has(key)) {
        serviceMap.set(key, { url: key, datasets: [] });
      }
      serviceMap.get(key).datasets.push({ id: d.id, title: d._layer_name || d.title || d.id });
    });

    await env.BUCKET.delete(R2_KEY_HEALTH_TASK);
    task = { services: [...serviceMap.values()], results: [] };
  } else {
    const obj = await env.BUCKET.get(R2_KEY_HEALTH_TASK);
    if (!obj) { return { error: 'No task found', done: true }; }
    task = JSON.parse(await obj.text());
  }

  // Process this batch in parallel to stay within Worker wall-clock limit
  const batch = task.services.slice(offset, offset + HEALTH_BATCH_SIZE);
  console.log(`Health scan batch: offset=${offset}, batchSize=${batch.length}, total=${task.services.length}`);

  const batchResults = await Promise.allSettled(
    batch.map(async (svc) => {
      const check = await checkServiceHealth(svc.url);
      return { url: svc.url, datasets: svc.datasets, status: check.status, detail: check.detail };
    })
  );
  for (let i = 0; i < batchResults.length; i++) {
    const r = batchResults[i];
    if (r.status === 'fulfilled') {
      task.results.push(r.value);
    } else {
      task.results.push({ url: batch[i].url, datasets: batch[i].datasets, status: 'unknown', detail: r.reason?.message || 'Unknown error' });
    }
  }

  const nextOffset = offset + HEALTH_BATCH_SIZE;
  const done = nextOffset >= task.services.length;

  if (!done) {
    // Save progress for next batch
    await env.BUCKET.put(R2_KEY_HEALTH_TASK, JSON.stringify(task));
  }

  // Always write current results to health.json (partial or final)
  let okCount = 0, badCount = 0, unknownCount = 0;
  task.results.forEach(r => {
    if (r.status === 'ok') okCount++;
    else if (r.status === 'bad') badCount++;
    else unknownCount++;
  });

  const output = {
    generated: new Date().toISOString(),
    totalChecked: task.services.length,
    ok: okCount,
    bad: badCount,
    unknown: unknownCount,
    services: task.results,
    _scanComplete: done,
  };

  await env.BUCKET.put(R2_KEY_HEALTH, JSON.stringify(output, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  if (done) {
    await env.BUCKET.delete(R2_KEY_HEALTH_TASK);
    console.log(`Health scan complete: ok=${okCount} bad=${badCount} unknown=${unknownCount}`);
  }

  return {
    done,
    offset,
    nextOffset: done ? null : nextOffset,
    total: task.services.length,
    processed: task.results.length,
    batchSize: batch.length,
  };
}

// ================================================================
// Service health check (server-side — no CORS limitations)
// ================================================================

function isArcGisRestUrl(url) {
  const u = String(url || '').toUpperCase();
  return u.includes('/REST/SERVICES/') && (u.includes('/MAPSERVER') || u.includes('/FEATURESERVER') || u.includes('/IMAGESERVER'));
}

async function checkServiceHealth(url) {
  if (!url) return { status: 'bad', detail: 'No URL' };

  try { new URL(url); } catch { return { status: 'bad', detail: 'Invalid URL' }; }

  if (isArcGisRestUrl(url)) {
    return checkArcGisHealth(url);
  }
  return checkSimpleHealth(url);
}

async function checkArcGisHealth(url) {
  const parsed = parseServiceUrl(url);
  if (!parsed) return { status: 'bad', detail: 'Could not parse ArcGIS REST URL' };

  // Single-fetch health check: verify service metadata is accessible.
  // Skips the query step to conserve subrequests within Cloudflare's limit.
  try {
    const target = parsed.layerId !== null ? url.replace(/\?.*$/, '') : parsed.base;
    const serviceJson = await fetchJson(`${target}?f=pjson`, HEALTH_TIMEOUT_MS);

    if (serviceJson?.error) {
      return { status: 'bad', detail: `Service error (${serviceJson.error.code || ''}): ${serviceJson.error.message || 'Unknown'}` };
    }

    if (serviceJson.currentVersion || serviceJson.name || serviceJson.serviceDataType || serviceJson.layers || serviceJson.type) {
      return { status: 'ok', detail: `Service responding (v${serviceJson.currentVersion || '?'})` };
    }

    return { status: 'unknown', detail: 'Response missing expected ArcGIS fields' };
  } catch (e) {
    return { status: 'bad', detail: `Service unreachable: ${e.message}` };
  }
}

async function checkSimpleHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    const ok = resp.status >= 200 && resp.status < 400;
    return { status: ok ? 'ok' : 'bad', detail: ok ? 'URL reachable' : `HTTP ${resp.status}` };
  } catch (e) {
    return { status: 'bad', detail: `Network error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ================================================================
// HTTP helpers
// ================================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(url, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRetry(fn) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= MAX_RETRIES) throw e;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function normalizeUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function parseServiceUrl(url) {
  const m = url.match(/(.*\/(?:MapServer|FeatureServer|ImageServer))(?:\/(\d+))?/i);
  if (!m) return null;
  return { base: m[1], layerId: m[2] !== undefined ? Number(m[2]) : null };
}

function isImageServer(url) {
  return String(url || '').toUpperCase().includes('/IMAGESERVER');
}

// ================================================================
// Date field detection
// ================================================================

function dateFieldPriority(name) {
  const n = name.toUpperCase();
  if (/LAST.?EDIT/.test(n) || /EDIT.?DATE/.test(n)) return 0;
  if (/MODIF/.test(n) || /UPDATE/.test(n)) return 1;
  if (/CREATE/.test(n)) return 2;
  return 3;
}

// ── Date validation (rejects obvious sentinel/placeholder values) ──
function isValidRealisticDate(date) {
  if (!date || isNaN(date.getTime())) return false;
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // Reject dates more than 1 year in the future
  if (year > currentYear + 1) return false;
  
  // Reject far-future placeholder (year 9999)
  if (year === 9999) return false;
  
  // Reject common database sentinel dates (exactly Jan 1 of these years)
  // These are often default/null values in databases, not real data
  if ((year === 1899 || year === 1900) && month === 0 && day === 1) return false;
  
  // Reject Unix epoch exactly (Jan 1, 1970 00:00:00.000) — uninitialized timestamp
  if (date.getTime() === 0) return false;
  
  return true;
}

async function queryMaxDate(target, fieldName) {
  const params = new URLSearchParams({
    where: '1=1',
    outStatistics: JSON.stringify([
      { statisticType: 'max', onStatisticField: fieldName, outStatisticFieldName: 'max_date' },
    ]),
    f: 'json',
  });
  const json = await fetchRetry(() => fetchJson(`${target}/query?${params}`, TIMEOUT_MS));
  const val = json?.features?.[0]?.attributes?.max_date;
  if (val == null) return null;
  const d = new Date(typeof val === 'number' ? val : val);
  return isValidRealisticDate(d) ? d.toISOString() : null;
}

// ================================================================
// Process a single dataset (mirrors scripts/generate-freshness.js)
// ================================================================

async function processDataset(ds, storedRecordCount, env) {
  const url = normalizeUrl(ds.public_web_service);
  const parsed = parseServiceUrl(url);
  if (!parsed) return null;

  const _isImageSvc = isImageServer(url);
  const isLayerUrl = parsed.layerId !== null;

  let queryTarget;

  if (_isImageSvc) {
    queryTarget = parsed.base;
  } else if (isLayerUrl) {
    queryTarget = url;
  } else {
    // Discover first layer
    let layerId = 0;
    try {
      const svcJson = await fetchRetry(() => fetchJson(`${parsed.base}?f=pjson`, TIMEOUT_MS));
      if (svcJson?.layers?.length) layerId = svcJson.layers[0].id ?? 0;
    } catch (_) {}
    queryTarget = `${parsed.base}/${layerId}`;
  }

  const signals = [];

  // ── Fetch layer JSON ──
  let layerJson = null;
  try {
    layerJson = await fetchRetry(() => fetchJson(`${queryTarget}?f=pjson`, TIMEOUT_MS));
  } catch (e) {
    signals.push({ signal: 'layer_fetch', value: null, confidence: 'none', detail: `Could not reach layer: ${e.message}` });
    return {
      datasetId: ds.id, signals, lastUpdated: null, signal: 'none',
      confidence: 'none', details: 'Service unreachable', recordCount: null,
    };
  }

  // ── Signal 1: editingInfo.lastEditDate ──
  const editDate = layerJson?.editingInfo?.lastEditDate;
  if (editDate && typeof editDate === 'number' && editDate > 0) {
    const d = new Date(editDate);
    if (isValidRealisticDate(d)) {
      signals.push({ signal: 'editingInfo.lastEditDate', value: d.toISOString(), confidence: 'high', detail: `editingInfo.lastEditDate = ${d.toISOString()}` });
    } else {
      signals.push({ signal: 'editingInfo.lastEditDate', value: null, confidence: 'none', detail: `Unrealistic date (year ${d.getFullYear()})` });
    }
  } else {
    signals.push({ signal: 'editingInfo.lastEditDate', value: null, confidence: 'none', detail: 'Not exposed' });
  }

  // ── Signal 2: Editor tracking field ──
  const trackingField = layerJson?.editFieldsInfo?.editDateField || layerJson?.editFieldsInfo?.lastEditDateField;
  if (_isImageSvc) {
    signals.push({ signal: 'editor_tracking', value: null, confidence: 'none', detail: 'Skipped — ImageServer' });
  } else if (trackingField) {
    try {
      const maxDate = await queryMaxDate(queryTarget, trackingField);
      signals.push(maxDate
        ? { signal: 'editor_tracking', value: maxDate, confidence: 'high', detail: `MAX(${trackingField}) = ${maxDate}` }
        : { signal: 'editor_tracking', value: null, confidence: 'none', detail: `${trackingField} returned no data` });
    } catch (e) {
      signals.push({ signal: 'editor_tracking', value: null, confidence: 'none', detail: e.message });
    }
  } else {
    signals.push({ signal: 'editor_tracking', value: null, confidence: 'none', detail: 'No editor tracking' });
  }

  // ── Signal 3: Date field heuristic ──
  // Compute dateFields for use by both Signal 3 and Signal 6
  const wFields = _isImageSvc ? [] : (layerJson?.fields || []);
  const dateFields = _isImageSvc ? [] : wFields
    .filter(f => (f.type || '').toUpperCase().includes('DATE'))
    .filter(f => f.name !== trackingField)
    .sort((a, b) => dateFieldPriority(a.name) - dateFieldPriority(b.name));

  if (_isImageSvc) {
    signals.push({ signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'Skipped — ImageServer' });
  } else {

    if (dateFields.length > 0) {
      const candidates = dateFields.slice(0, 3);
      let bestDate = null;
      let bestField = null;
      for (const f of candidates) {
        try {
          const maxDate = await queryMaxDate(queryTarget, f.name);
          if (maxDate && (!bestDate || new Date(maxDate) > new Date(bestDate))) {
            bestDate = maxDate;
            bestField = f.name;
          }
        } catch (_) {}
      }
      const priority = bestField ? dateFieldPriority(bestField) : 4;
      const conf = priority <= 1 ? 'medium' : 'low';
      signals.push(bestDate
        ? { signal: 'date_field_heuristic', value: bestDate, confidence: conf, detail: `MAX(${bestField}) = ${bestDate}` }
        : { signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'No dates found' });
    } else {
      signals.push({ signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'No date fields' });
    }
  }

  // ── Signal 4: Record count delta ──
  let currentCount = null;
  if (!_isImageSvc) {
    try {
      const cp = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
      const cj = await fetchRetry(() => fetchJson(`${queryTarget}/query?${cp}`, TIMEOUT_MS));
      currentCount = cj?.count ?? null;
    } catch (_) {}
  }
  if (currentCount !== null && storedRecordCount !== null) {
    const delta = currentCount - storedRecordCount;
    signals.push({
      signal: 'record_count_delta',
      value: delta !== 0 ? `${delta > 0 ? '+' : ''}${delta}` : '0',
      confidence: delta !== 0 ? 'low' : 'none',
      detail: `${storedRecordCount.toLocaleString()} → ${currentCount.toLocaleString()} (${delta > 0 ? '+' : ''}${delta.toLocaleString()})`,
    });
  }

  // ── Signal 5: Metadata text ──
  const desc = layerJson?.description || layerJson?.serviceDescription || '';
  const copy = layerJson?.copyrightText || '';
  const stripHtml = s => s.replace(/<[^>]+>/g, ' ');
  const allText = [desc, copy].map(stripHtml).join(' ');

  const MON = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const DATE_RE = `(${MON}\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/]\\d{1,2}[-/]\\d{4}|\\d{1,2}[-/]\\d{4}|${MON}\\s+\\d{4})`;
  const META_KW = '(?:(?:last\\s+)?(?:updated?|modified|revised|edited|refreshed|published)(?:\\s+(?:on|as\\s+of))?|(?:current|data)\\s+(?:as\\s+of|through)|effective|vintage|as\\s+of)';
  const parseMetaDate = (s) => {
    const my = s.match(/^(\d{1,2})[-/](\d{4})$/);
    if (my) { const m = +my[1]; return m >= 1 && m <= 12 ? new Date(+my[2], m - 1, 1) : null; }
    if (/^[A-Za-z]/.test(s) && /^\w+\s+\d{4}$/.test(s)) {
      const d = new Date(s.replace(/^(\w+)\s+(\d{4})$/, '$1 1, $2'));
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  let metaSignalPushed = false;
  const kwMatch = allText.match(new RegExp(META_KW + '[:\\s]+' + DATE_RE, 'i'));
  if (kwMatch) {
    const parsed = parseMetaDate(kwMatch[1]);
    if (parsed && isValidRealisticDate(parsed)) {
      signals.push({ signal: 'metadata_text', value: parsed.toISOString(), confidence: 'medium', detail: `Found "${kwMatch[0].trim()}"` });
      metaSignalPushed = true;
    }
  }
  if (!metaSignalPushed) {
    const dateOnly = allText.match(new RegExp(DATE_RE, 'i'));
    if (dateOnly) {
      const parsed = parseMetaDate(dateOnly[1]);
      if (parsed && isValidRealisticDate(parsed)) {
        signals.push({ signal: 'metadata_text', value: parsed.toISOString(), confidence: 'low', detail: `Found date "${dateOnly[0].trim()}"` });
      }
    }
  }

  // ── Signal 6: Any remaining date field fallback ──
  if (!_isImageSvc && dateFields.length > 3) {
    const hasDateResult = signals.some(s =>
      s.value !== null && s.confidence !== 'none' &&
      ['editingInfo.lastEditDate', 'editor_tracking', 'date_field_heuristic'].includes(s.signal)
    );
    if (!hasDateResult) {
      const remaining = dateFields.slice(3);
      let bestDate = null;
      let bestField = null;
      for (const f of remaining) {
        try {
          const maxDate = await queryMaxDate(queryTarget, f.name);
          if (maxDate) {
            const d = new Date(maxDate);
            if (isValidRealisticDate(d) && (!bestDate || d > new Date(bestDate))) {
              bestDate = maxDate;
              bestField = f.name;
            }
          }
        } catch (_) {}
      }
      signals.push(bestDate
        ? { signal: 'any_date_field', value: bestDate, confidence: 'low', detail: `Fallback: MAX(${bestField}) = ${bestDate}` }
        : { signal: 'any_date_field', value: null, confidence: 'none', detail: `Queried ${remaining.length} remaining date field${remaining.length > 1 ? 's' : ''} — no valid dates` }
      );
    }
  }

  // ── Pick best signal ──
  const confOrder = { high: 0, medium: 1, low: 2, none: 3 };
  const ranked = signals
    .filter(s => s.value !== null && s.confidence !== 'none')
    .sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);
  const best = ranked[0] || null;

  return {
    datasetId: ds.id,
    lastUpdated: best ? best.value : null,
    signal: best ? best.signal : 'none',
    confidence: best ? best.confidence : 'none',
    details: best ? best.detail : 'No freshness signal found',
    signals,
    recordCount: currentCount,
  };
}
