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
//
// Routes:
//   GET  /freshness.json      → serve from R2
//   POST /freshness/refresh   → run freshness scan, store in R2
//   GET  /freshness/status    → last-generated timestamp
//   GET  /health.json         → serve from R2
//   POST /health/refresh      → run health scan, store in R2
//   GET  /health/status       → last-generated timestamp
//   Cron trigger              → runs both scans
// ================================================================

const R2_KEY = 'freshness.json';
const R2_KEY_PREV = 'freshness-previous.json';
const R2_KEY_HEALTH = 'health.json';
const R2_KEY_HEALTH_TASK = 'health-task.json';
const R2_KEY_FRESHNESS_TASK = 'freshness-task.json';
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

    return corsJson({ error: 'Not found' }, 404);
  },

  // ── Cron Trigger — runs first batch of each scan ──
  // Cron only processes batch 0; partial results are written to R2.
  // Full completion requires the dashboard to drive subsequent batches.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        runHealthScan(env, 0),
        runScan(env, 0),
      ])
    );
  },
};

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

  for (const ds of batch) {
    const stored = task.existing[ds.id] || task.existing[ds.datasetId];
    const storedCount = stored?.recordCount ?? null;
    try {
      const result = await processDataset(ds, storedCount, env);
      if (result) task.results.push(result);
    } catch (e) {
      console.log(`  Error processing ${ds.id}: ${e.message}`);
      task.results.push({
        datasetId: ds.id, lastUpdated: null, signal: 'none',
        confidence: 'none', details: e.message, signals: [], recordCount: null,
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

  // Process this batch sequentially (1 fetch per service)
  const batch = task.services.slice(offset, offset + HEALTH_BATCH_SIZE);
  console.log(`Health scan batch: offset=${offset}, batchSize=${batch.length}, total=${task.services.length}`);

  for (const svc of batch) {
    try {
      const check = await checkServiceHealth(svc.url);
      task.results.push({ url: svc.url, datasets: svc.datasets, status: check.status, detail: check.detail });
    } catch (e) {
      task.results.push({ url: svc.url, datasets: svc.datasets, status: 'unknown', detail: e.message });
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
  return isNaN(d.getTime()) ? null : d.toISOString();
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
    if (!isNaN(d.getTime())) {
      signals.push({ signal: 'editingInfo.lastEditDate', value: d.toISOString(), confidence: 'high', detail: `editingInfo.lastEditDate = ${d.toISOString()}` });
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
  if (_isImageSvc) {
    signals.push({ signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'Skipped — ImageServer' });
  } else {
    const fields = layerJson?.fields || [];
    const dateFields = fields
      .filter(f => (f.type || '').toUpperCase().includes('DATE'))
      .filter(f => f.name !== trackingField)
      .sort((a, b) => dateFieldPriority(a.name) - dateFieldPriority(b.name));

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
  const match = `${desc} ${copy}`.match(
    /(?:last\s+(?:updated?|modified|revised))[:\s]*(\w+\s+\d{1,2},?\s+\d{4}|\d{4}[-/]\d{2}[-/]\d{2})/i
  );
  if (match) {
    try {
      const d = new Date(match[1]);
      if (!isNaN(d.getTime())) {
        signals.push({ signal: 'metadata_text', value: d.toISOString(), confidence: 'low', detail: `Found "${match[0]}"` });
      }
    } catch (_) {}
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
