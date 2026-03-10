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
//   performance.json         — latest query performance benchmark results
//   performance-task.json    — in-progress performance scan state
//
// Routes:
//   GET  /freshness.json      → serve from R2
//   POST /freshness/refresh   → run freshness scan, store in R2
//   GET  /freshness/status    → last-generated timestamp
//   GET  /health.json         → serve from R2
//   POST /health/refresh      → run health scan, store in R2
//   GET  /health/status       → last-generated timestamp
//   GET  /performance.json    → serve from R2
//   POST /performance/refresh → run performance scan, store in R2
//   GET  /performance/status  → last-generated timestamp
//   Cron trigger              → runs batched scans (see below)
//
// Batch Processing Strategy:
//   Cloudflare Workers have a 50-subrequest limit per invocation (free plan).
//   To handle large catalogs, scans are split into batches:
//   - Health: 10 services per batch (~30 fetches, full 3-step validation)
//   - Freshness: 5 datasets per batch (~20 fetches)
//
//   Cron runs every minute from 6:00-6:30 and 18:00-18:30 UTC (twice daily).
//   Each invocation:
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
const R2_KEY_PERF = 'performance.json';
const R2_KEY_PERF_TASK = 'performance-task.json';
const R2_KEY_OVERRIDES = 'catalog-overrides.json';
const TIMEOUT_MS = 12_000;
const HEALTH_TIMEOUT_MS = 15_000;
const PERF_TIMEOUT_MS = 8_000;
const CONCURRENCY = 4;
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2_000;

// ── Batch-and-chain settings ──
// Cloudflare Workers free plan: 50 outbound fetch() per invocation.
// We split scans into small batches to stay under this limit.
// Health: ~3 fetches per service + 1 retry for failures (~6 worst case) → batch of 7 = ~42 subrequests.
// Freshness: ~5 fetches per dataset (incl. FGDC metadata XML) → batch of 5 = ~27 subrequests.
const HEALTH_BATCH_SIZE = 7;
const FRESHNESS_BATCH_SIZE = 5;
// Performance: 5 timed queries per dataset × 3 datasets = ~15 subrequests per batch.
// Batch kept small since each dataset runs 5-6 sequential fetches and some
// government servers respond slowly (up to 8s per query).
const PERF_BATCH_SIZE = 3;

// ── CORS headers applied to every response ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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

    // ── GET /performance.json ──
    if (request.method === 'GET' && (path === '/performance.json' || path === '/performance')) {
      return serveR2Json(env, R2_KEY_PERF);
    }

    // ── GET /performance/status ──
    if (request.method === 'GET' && path === '/performance/status') {
      return serveStatus(env, R2_KEY_PERF);
    }

    // ── POST /performance/refresh ──
    if (request.method === 'POST' && path === '/performance/refresh') {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (offset === 0 && env.REFRESH_TOKEN) {
        const auth = request.headers.get('Authorization') || '';
        if (auth !== `Bearer ${env.REFRESH_TOKEN}`) {
          return corsJson({ error: 'Unauthorized' }, 401);
        }
      }
      const result = await runPerformanceScan(env, offset);
      return corsJson(result);
    }

    // ── GET /catalog/overrides.json ──
    if (request.method === 'GET' && (path === '/catalog/overrides.json' || path === '/catalog/overrides')) {
      return serveR2Json(env, R2_KEY_OVERRIDES);
    }

    // ── GET /auth/github — redirect to GitHub OAuth ──
    if (request.method === 'GET' && path === '/auth/github') {
      return handleAuthGithub(request, env);
    }

    // ── GET /auth/callback — GitHub OAuth callback ──
    if (request.method === 'GET' && path === '/auth/callback') {
      return handleAuthCallback(request, env);
    }

    // ── PATCH /catalog/dataset/:id ──
    const patchMatch = path.match(/^\/catalog\/dataset\/(.+)$/);
    if (request.method === 'PATCH' && patchMatch) {
      return handleDatasetPatch(request, env, decodeURIComponent(patchMatch[1]));
    }

    // ── DELETE /catalog/dataset/:id ──
    const deleteMatch = path.match(/^\/catalog\/dataset\/(.+)$/);
    if (request.method === 'DELETE' && deleteMatch) {
      return handleDatasetDelete(request, env, decodeURIComponent(deleteMatch[1]));
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
// 50 subrequests (HEALTH_BATCH_SIZE=10×~3=30, FRESHNESS_BATCH_SIZE=5×~4=20).
// Requires multiple cron triggers (twice daily: 6:00-6:30, 18:00-18:30 UTC).

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

  // Check for incomplete performance task
  const perfTask = await env.BUCKET.get(R2_KEY_PERF_TASK);
  if (perfTask) {
    const task = JSON.parse(await perfTask.text());
    const offset = task.results?.length || 0;
    console.log(`Continuing performance scan from offset ${offset}`);
    await runPerformanceScan(env, offset);
    return;
  }

  // No incomplete tasks — check if we should start fresh scans
  // Only start new scans if existing data is stale (>20 hours old)
  const healthObj = await env.BUCKET.get(R2_KEY_HEALTH);
  const freshnessObj = await env.BUCKET.get(R2_KEY);
  const perfObj = await env.BUCKET.get(R2_KEY_PERF);
  
  const now = Date.now();
  const STALE_THRESHOLD_MS = 20 * 60 * 60 * 1000; // 20 hours
  
  let healthStale = true;
  let freshnessStale = true;
  let perfStale = true;
  
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

  if (perfObj) {
    try {
      const data = JSON.parse(await perfObj.text());
      if (data.generated && data._scanComplete !== false) {
        perfStale = (now - new Date(data.generated).getTime()) > STALE_THRESHOLD_MS;
      }
    } catch (_) {}
  }

  // Start whichever scan is stale (health first, then freshness, then performance)
  if (healthStale) {
    console.log('Starting new health scan (data stale or missing)');
    await runHealthScan(env, 0);
  } else if (freshnessStale) {
    console.log('Starting new freshness scan (data stale or missing)');
    await runScan(env, 0);
  } else if (perfStale) {
    console.log('Starting new performance scan (data stale or missing)');
    await runPerformanceScan(env, 0);
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
// GitHub OAuth helpers
// ================================================================

async function generateOAuthState(secret) {
  const timestamp = Date.now().toString();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp));
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${timestamp}.${sigHex}`;
}

async function verifyOAuthState(state, secret) {
  const dot = state.indexOf('.');
  if (dot < 1) return false;
  const timestamp = state.slice(0, dot);
  const sigHex = state.slice(dot + 1);
  if (Date.now() - parseInt(timestamp, 10) > 10 * 60 * 1000) return false; // 10 min expiry
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp));
  const expectedHex = [...new Uint8Array(expected)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigHex === expectedHex;
}

async function validateGithubUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return { error: 'missing_token' };
  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${match[1]}`, 'User-Agent': 'GIS-Catalog-Worker' },
    });
    if (!resp.ok) return { error: 'token_invalid', status: resp.status };
    const user = await resp.json();
    const allowed = (env.GITHUB_ALLOWED_USERS || '').split(',').map(u => u.trim().toLowerCase());
    if (!allowed.includes(user.login?.toLowerCase())) return { error: 'not_allowed', login: user.login };
    return { login: user.login };
  } catch (_) {
    return { error: 'token_invalid' };
  }
}

// ── GET /auth/github — redirect to GitHub OAuth authorize ──
async function handleAuthGithub(request, env) {
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId || !env.GITHUB_CLIENT_SECRET) {
    return corsJson({ error: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the Worker.' }, 501);
  }
  const state = await generateOAuthState(env.GITHUB_CLIENT_SECRET);
  const redirectUri = new URL('/auth/callback', request.url).href;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
  });
  return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
}

// ── GET /auth/callback — exchange code for token, verify user, return to popup ──
async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const frontendOrigin = (env.CATALOG_BASE_URL || '*').replace(/\/+$/, '');

  if (!code || !state || !await verifyOAuthState(state, env.GITHUB_CLIENT_SECRET)) {
    return new Response(oauthCallbackPage({ error: 'Invalid or expired OAuth state. Please try again.' }, frontendOrigin), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Exchange code for access token
  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'GIS-Catalog-Worker' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const tokenData = await tokenResp.json();
  if (tokenData.error) {
    return new Response(oauthCallbackPage({ error: tokenData.error_description || tokenData.error }, frontendOrigin), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Verify user identity
  const userResp = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'User-Agent': 'GIS-Catalog-Worker' },
  });
  if (!userResp.ok) {
    return new Response(oauthCallbackPage({ error: 'Failed to verify GitHub identity.' }, frontendOrigin), {
      headers: { 'Content-Type': 'text/html' },
    });
  }
  const user = await userResp.json();

  // Check if user is in the allowed list
  const allowed = (env.GITHUB_ALLOWED_USERS || '').split(',').map(u => u.trim().toLowerCase());
  if (!allowed.includes(user.login?.toLowerCase())) {
    return new Response(oauthCallbackPage({ error: `User "${user.login}" is not authorized to edit this catalog.` }, frontendOrigin), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(
    oauthCallbackPage({ token: tokenData.access_token, user: { login: user.login, avatar_url: user.avatar_url } }, frontendOrigin),
    { headers: { 'Content-Type': 'text/html' } }
  );
}

function oauthCallbackPage(data, targetOrigin) {
  // Safely serialize data — escape < to prevent </script> injection
  const safeJson = JSON.stringify({ type: 'github-auth', ...data }).replace(/</g, '\\u003c');
  const safeOrigin = targetOrigin.replace(/'/g, "\\'").replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><body>
<script>if(window.opener){window.opener.postMessage(${safeJson},'${safeOrigin}');window.close();}else{document.body.textContent='Authentication complete. You can close this window.';}</script>
<p>Authenticating\u2026 this window should close automatically.</p>
</body></html>`;
}

// ================================================================
// Handle PATCH /catalog/dataset/:id — admin inline edits
// ================================================================
// Stores per-dataset field overrides in R2 (catalog-overrides.json).
// Body: { fields: { key: value, ... } }
// Auth: Bearer <github_access_token> — validated against GitHub API
// The overrides file is a simple map: { datasetId: { field: value, ... }, ... }
// The frontend merges these on top of the base catalog.json at load time.

async function handleDatasetPatch(request, env, datasetId) {
  // Auth check — validate GitHub token and check user is allowed
  const result = await validateGithubUser(request, env);
  if (result.error) {
    if (result.error === 'not_allowed') {
      return corsJson({ error: `User "${result.login}" is not in the authorized editors list. Ask a repo admin to add your GitHub username to GITHUB_ALLOWED_USERS.`, code: 'not_allowed' }, 403);
    }
    // token_invalid or missing_token — prompt re-login
    return corsJson({ error: 'GitHub session expired or invalid. Please log in again.', code: 'token_expired' }, 401);
  }
  const ghUser = result.login;

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
// Handle DELETE /catalog/dataset/:id — admin dataset removal
// ================================================================
// Marks a dataset as deleted by setting { _deleted: true } in overrides.
// The frontend filters out deleted datasets when merging overrides at load time.
// The base catalog.json is never modified — deletion is a soft override.

async function handleDatasetDelete(request, env, datasetId) {
  const result = await validateGithubUser(request, env);
  if (result.error) {
    if (result.error === 'not_allowed') {
      return corsJson({ error: `User "${result.login}" is not in the authorized editors list. Ask a repo admin to add your GitHub username to GITHUB_ALLOWED_USERS.`, code: 'not_allowed' }, 403);
    }
    return corsJson({ error: 'GitHub session expired or invalid. Please log in again.', code: 'token_expired' }, 401);
  }

  let overrides = {};
  try {
    const obj = await env.BUCKET.get(R2_KEY_OVERRIDES);
    if (obj) overrides = JSON.parse(await obj.text());
  } catch (_) {}

  // Mark as deleted — replaces any existing field overrides for this dataset
  overrides[datasetId] = { _deleted: true };

  await env.BUCKET.put(R2_KEY_OVERRIDES, JSON.stringify(overrides, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return corsJson({ ok: true, datasetId, deleted: true });
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
      let check = await checkServiceHealth(svc.url);
      // Retry once for non-ok results (transient timeouts / slow government servers)
      if (check.status !== 'ok') {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        check = await checkServiceHealth(svc.url);
      }
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

  const isLayerUrl = parsed.layerId !== null;
  const cleanUrl = url.replace(/\?.*$/, '');

  // Step 1: Fetch metadata for the target URL (layer or service root)
  // Layer URLs → fetch layer JSON directly (gives type, fields, capabilities)
  // Service roots → fetch service JSON (gives layers list, capabilities, version)
  let metaJson;
  try {
    const metaUrl = isLayerUrl ? `${cleanUrl}?f=pjson` : `${parsed.base}?f=pjson`;
    metaJson = await fetchJson(metaUrl, HEALTH_TIMEOUT_MS);
  } catch (e) {
    return { status: 'bad', detail: `Service endpoint unreachable: ${e.message}` };
  }

  // ArcGIS error response (token required, forbidden, service not found, etc.)
  if (metaJson?.error) {
    return { status: 'bad', detail: `Service error (${metaJson.error.code || ''}): ${metaJson.error.message || 'Unknown'}` };
  }

  // Validate that the response is genuine ArcGIS REST metadata
  const hasServiceFields = metaJson && (metaJson.currentVersion || metaJson.layers || metaJson.serviceDescription != null || metaJson.mapName);
  const hasLayerFields = metaJson && (metaJson.type || metaJson.fields || (metaJson.name && metaJson.id != null));
  if (!hasServiceFields && !hasLayerFields) {
    return { status: 'bad', detail: 'Response is not valid ArcGIS service metadata' };
  }

  // ── Service is confirmed alive from this point ──
  // Query failures below yield 'ok' with descriptive detail, never 'bad' or 'unknown'.

  // Step 2: ImageServer — metadata alone confirms health (no /query endpoint)
  if (isImageServer(url)) {
    return { status: 'ok', detail: 'ImageServer serving metadata' };
  }

  // Step 3: Determine a queryable layer target (skip group layers)
  const capabilities = (metaJson.capabilities || '').toUpperCase();
  const supportsQuery = capabilities.includes('QUERY') || !capabilities;
  let queryTarget = null;

  if (isLayerUrl) {
    // Check if the targeted layer is a group layer (not directly queryable)
    const isGroup = metaJson.type === 'Group Layer' ||
      (Array.isArray(metaJson.subLayerIds) && metaJson.subLayerIds.length > 0);
    if (!isGroup) {
      queryTarget = cleanUrl;
    }
  } else {
    // Service root: find first non-group layer for querying
    const layers = metaJson.layers || [];
    for (const layer of layers) {
      if (Array.isArray(layer.subLayerIds) && layer.subLayerIds.length > 0) continue;
      queryTarget = `${parsed.base}/${layer.id}`;
      break;
    }
    // All top-level entries are groups — try first sublayer of first group
    if (!queryTarget && layers.length > 0 && Array.isArray(layers[0].subLayerIds) && layers[0].subLayerIds.length > 0) {
      queryTarget = `${parsed.base}/${layers[0].subLayerIds[0]}`;
    }
  }

  // Step 4: Attempt count query (best-effort enrichment — service already confirmed up)
  if (queryTarget && supportsQuery) {
    try {
      const countParams = new URLSearchParams({
        where: '1=1',
        returnCountOnly: 'true',
        f: 'json',
      });
      const countJson = await fetchJson(`${queryTarget}/query?${countParams}`, HEALTH_TIMEOUT_MS);

      if (countJson && !countJson.error && typeof countJson.count === 'number') {
        if (countJson.count > 0) {
          return { status: 'ok', detail: `Serving data (${countJson.count.toLocaleString()} features)` };
        }
        return { status: 'ok', detail: 'Service responding (0 features — layer may be empty or scale-filtered)' };
      }
      // Query returned error or unexpected format — fall through to metadata-based ok
    } catch (_) {
      // Query timed out or network error — fall through to metadata-based ok
    }
  }

  // Step 5: Report healthy based on confirmed metadata
  if (isLayerUrl) {
    if (metaJson.type === 'Group Layer') {
      return { status: 'ok', detail: `Group layer responding (${(metaJson.subLayerIds || []).length} sub-layers)` };
    }
    return { status: 'ok', detail: `Layer metadata confirmed${!supportsQuery ? ' (query not supported)' : ''}` };
  }
  const layerCount = (metaJson.layers || []).length;
  if (layerCount > 0) {
    return { status: 'ok', detail: `Service responding (${layerCount} layer${layerCount !== 1 ? 's' : ''}${!supportsQuery ? ', query not supported' : ''})` };
  }
  return { status: 'ok', detail: 'Service serving metadata' };
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

async function fetchXmlText(layerUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${layerUrl}/metadata`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseFgdcDate(xml) {
  if (!xml || typeof xml !== 'string') return null;
  const tagPattern = /<(?:pubdate|pubDate|caldate)>([\d\-]+)<\/(?:pubdate|pubDate|caldate)>/gi;
  let best = null;
  let m;
  while ((m = tagPattern.exec(xml)) !== null) {
    const raw = m[1].trim();
    const d = parseFgdcDateValue(raw);
    if (d && isValidRealisticDate(d) && (!best || d > best)) {
      best = d;
    }
  }
  return best;
}

function parseFgdcDateValue(raw) {
  if (/^\d{8}$/.test(raw)) {
    const y = +raw.slice(0, 4), mo = +raw.slice(4, 6) - 1, day = +raw.slice(6, 8);
    const d = new Date(y, mo, day);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{6}$/.test(raw)) {
    const y = +raw.slice(0, 4), mo = +raw.slice(4, 6) - 1;
    const d = new Date(y, mo, 1);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}$/.test(raw)) {
    const d = new Date(+raw, 0, 1);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
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
  if (/^MODIFIED$/i.test(name) || /MODIF/.test(n) || /UPDATE/.test(n)) return 1;
  if (/^CREATED$/i.test(name) || /CREATE/.test(n)) return 2;
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
      // Modification/edit fields → high, creation fields → medium, others → low
      const conf = priority <= 1 ? 'high' : priority <= 2 ? 'medium' : 'low';
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
  // Also check service-level metadata (copyright/description may differ from layer-level)
  let svcDesc = '', svcCopy = '';
  try {
    const svcRoot = await fetchRetry(() => fetchJson(`${parsed.base}?f=pjson`, TIMEOUT_MS));
    svcDesc = svcRoot?.serviceDescription || svcRoot?.description || '';
    svcCopy = svcRoot?.copyrightText || '';
  } catch (_) {}
  const stripHtml = s => s.replace(/<[^>]+>/g, ' ');
  const allText = [desc, copy, svcDesc, svcCopy].map(stripHtml).join(' ');

  const MON = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const DATE_RE = `(${MON},?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/]\\d{1,2}[-/]\\d{4}|\\d{1,2}[-/]\\d{4}|${MON},?\\s+\\d{4})`;
  const META_KW = '(?:(?:last\\s+)?(?:updated?|modified|revised|edited|refreshed|published)(?:\\s+(?:on|as\\s+of))?|(?:current|data)\\s+(?:as\\s+of|through)|(?:data\\s+)?refreshed|effective|vintage|as\\s+of)';
  const parseMetaDate = (s) => {
    const mcy = s.match(/^([A-Za-z]+),\s+(\d{4})$/);
    if (mcy) { const d = new Date(`${mcy[1]} 1, ${mcy[2]}`); return isNaN(d.getTime()) ? null : d; }
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

  // ── Signal 6: FGDC/ISO metadata XML (pubdate / caldate) ──
  try {
    const metaXml = await fetchXmlText(queryTarget);
    const fgdcDate = parseFgdcDate(metaXml);
    if (fgdcDate) {
      signals.push({
        signal: 'fgdc_metadata',
        value: fgdcDate.toISOString(),
        confidence: 'medium',
        detail: `FGDC/ISO metadata publication date: ${fgdcDate.toISOString().slice(0, 10)}`,
      });
    } else {
      signals.push({ signal: 'fgdc_metadata', value: null, confidence: 'none', detail: 'No publication date in FGDC/ISO metadata' });
    }
  } catch (_) {
    signals.push({ signal: 'fgdc_metadata', value: null, confidence: 'none', detail: 'Could not fetch FGDC/ISO metadata XML' });
  }

  // ── Signal 7: Any remaining date field fallback ──
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
    .sort((a, b) => {
      const cDiff = confOrder[a.confidence] - confOrder[b.confidence];
      if (cDiff !== 0) return cDiff;
      return new Date(b.value) - new Date(a.value);
    });
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

// ================================================================
// Performance scan — benchmarks query response times per dataset
// ================================================================
// Runs 5 standardised queries against each dataset's public web service
// and records response times. Results stored in performance.json on R2.
//
// Queries per dataset (~5 sub-requests):
//   1. Metadata fetch       — {layerUrl}?f=pjson
//   2. Count query           — /query?where=1=1&returnCountOnly=true
//   3. Attribute query       — /query?where=1=1&outFields=*&returnGeometry=false&resultRecordCount=10
//   4. Geometry query        — /query?where=1=1&outFields=*&returnGeometry=true&resultRecordCount=10
//   5. Spatial query         — /query?geometry={extent}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&returnCountOnly=true
//
// Grading thresholds (ms) per query type — based on ArcGIS REST service
// industry baselines for government enterprise GIS servers:
//
//   Grade:     A (Excellent)  B (Good)     C (Fair)     D (Poor)     F (Failing)
//   Metadata:  <300           <750         <1500        <3000        ≥3000
//   Count:     <300           <750         <1500        <3000        ≥3000
//   Attribute: <500           <1000        <2000        <4000        ≥4000
//   Geometry:  <750           <1500        <3000        <6000        ≥6000
//   Spatial:   <500           <1000        <2000        <4000        ≥4000
// ================================================================

const PERF_THRESHOLDS = {
  metadata:  [300, 750, 1500, 3000],
  count:     [300, 750, 1500, 3000],
  attribute: [500, 1000, 2000, 4000],
  geometry:  [750, 1500, 3000, 6000],
  spatial:   [500, 1000, 2000, 4000],
};

const GRADE_LETTERS = ['A', 'B', 'C', 'D', 'F'];
const GRADE_LABELS = ['Excellent', 'Good', 'Fair', 'Poor', 'Failing'];

function gradeForMetric(type, ms) {
  if (ms === null || ms === undefined) return null;
  const thresholds = PERF_THRESHOLDS[type];
  for (let i = 0; i < thresholds.length; i++) {
    if (ms < thresholds[i]) return GRADE_LETTERS[i];
  }
  return 'F';
}

function overallGrade(metrics) {
  // Convert each metric grade to a numeric score (A=4, B=3, C=2, D=1, F=0)
  // and compute a weighted average. Failures (null) count as F.
  const gradeScore = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  let totalScore = 0;
  let count = 0;
  for (const m of metrics) {
    if (m.grade) {
      totalScore += gradeScore[m.grade] ?? 0;
    }
    // Only count metrics that were attempted (responseMs !== undefined)
    if (m.responseMs !== undefined) count++;
  }
  if (count === 0) return 'N/A';
  const avg = totalScore / count;
  if (avg >= 3.5) return 'A';
  if (avg >= 2.5) return 'B';
  if (avg >= 1.5) return 'C';
  if (avg >= 0.5) return 'D';
  return 'F';
}

async function timedFetch(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = Date.now();
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const elapsed = Date.now() - start;
    if (!resp.ok) return { ok: false, elapsed, error: `HTTP ${resp.status}` };
    const json = await resp.json();
    const total = Date.now() - start;
    if (json?.error) return { ok: false, elapsed: total, error: json.error.message || 'ArcGIS error' };
    return { ok: true, elapsed: total, data: json };
  } catch (e) {
    return { ok: false, elapsed: Date.now() - start, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function benchmarkDataset(ds) {
  const url = normalizeUrl(ds.public_web_service);
  const parsed = parseServiceUrl(url);
  if (!parsed) return null;

  const _isImage = isImageServer(url);
  const isLayerUrl = parsed.layerId !== null;

  let queryTarget;
  if (_isImage) {
    queryTarget = parsed.base;
  } else if (isLayerUrl) {
    queryTarget = url;
  } else {
    let layerId = 0;
    try {
      const svcJson = await fetchJson(`${parsed.base}?f=pjson`, PERF_TIMEOUT_MS);
      if (svcJson?.layers?.length) layerId = svcJson.layers[0].id ?? 0;
    } catch (_) {}
    queryTarget = `${parsed.base}/${layerId}`;
  }

  const metrics = [];

  // 1. Metadata fetch
  const meta = await timedFetch(`${queryTarget}?f=pjson`, PERF_TIMEOUT_MS);
  metrics.push({
    query: 'metadata',
    label: 'Metadata Fetch',
    responseMs: meta.elapsed,
    grade: meta.ok ? gradeForMetric('metadata', meta.elapsed) : 'F',
    error: meta.ok ? null : meta.error,
  });

  if (_isImage) {
    // ImageServers don't support /query — return metadata-only results
    return {
      datasetId: ds.id,
      metrics,
      overall: overallGrade(metrics),
    };
  }

  // 2. Count query
  const countUrl = `${queryTarget}/query?where=${encodeURIComponent('1=1')}&returnCountOnly=true&f=json`;
  const countResult = await timedFetch(countUrl, PERF_TIMEOUT_MS);
  metrics.push({
    query: 'count',
    label: 'Count Query',
    responseMs: countResult.elapsed,
    grade: countResult.ok ? gradeForMetric('count', countResult.elapsed) : 'F',
    error: countResult.ok ? null : countResult.error,
  });

  // 3. Attribute query (10 rows, no geometry)
  const attrUrl = `${queryTarget}/query?where=${encodeURIComponent('1=1')}&outFields=*&returnGeometry=false&resultRecordCount=10&f=json`;
  const attrResult = await timedFetch(attrUrl, PERF_TIMEOUT_MS);
  metrics.push({
    query: 'attribute',
    label: 'Attribute Query',
    responseMs: attrResult.elapsed,
    grade: attrResult.ok ? gradeForMetric('attribute', attrResult.elapsed) : 'F',
    error: attrResult.ok ? null : attrResult.error,
  });

  // 4. Geometry query (10 rows, with geometry)
  const geomUrl = `${queryTarget}/query?where=${encodeURIComponent('1=1')}&outFields=*&returnGeometry=true&resultRecordCount=10&f=json`;
  const geomResult = await timedFetch(geomUrl, PERF_TIMEOUT_MS);
  metrics.push({
    query: 'geometry',
    label: 'Geometry Query',
    responseMs: geomResult.elapsed,
    grade: geomResult.ok ? gradeForMetric('geometry', geomResult.elapsed) : 'F',
    error: geomResult.ok ? null : geomResult.error,
  });

  // 5. Spatial query — use the layer extent (from metadata) as the envelope
  let spatialResult = null;
  const extent = meta.ok && meta.data?.extent;
  if (extent && extent.xmin != null) {
    const geomParam = JSON.stringify({
      xmin: extent.xmin, ymin: extent.ymin,
      xmax: extent.xmax, ymax: extent.ymax,
      spatialReference: extent.spatialReference,
    });
    const spatialUrl = `${queryTarget}/query?geometry=${encodeURIComponent(geomParam)}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&returnCountOnly=true&f=json`;
    spatialResult = await timedFetch(spatialUrl, PERF_TIMEOUT_MS);
  }
  metrics.push({
    query: 'spatial',
    label: 'Spatial Query',
    responseMs: spatialResult ? spatialResult.elapsed : null,
    grade: spatialResult?.ok ? gradeForMetric('spatial', spatialResult.elapsed) : (spatialResult ? 'F' : null),
    error: spatialResult ? (spatialResult.ok ? null : spatialResult.error) : 'No extent available',
  });

  return {
    datasetId: ds.id,
    metrics,
    overall: overallGrade(metrics),
  };
}

async function runPerformanceScan(env, offset = 0) {
  let task;

  if (offset === 0) {
    const catalogUrl = `${(env.CATALOG_BASE_URL || '').replace(/\/+$/, '')}/data/catalog.json`;
    let catalog;
    try {
      const resp = await fetch(catalogUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      catalog = await resp.json();
    } catch (e) {
      console.error('Performance scan: failed to fetch catalog.json:', e);
      return { error: 'Failed to fetch catalog', done: true };
    }

    const datasets = catalog.datasets || [];
    const toProcess = datasets.filter(ds => {
      if (!ds.public_web_service) return false;
      if (!/\/rest\/services\//i.test(ds.public_web_service)) return false;
      return true;
    });

    console.log(`Performance scan: ${toProcess.length} datasets to benchmark in batches of ${PERF_BATCH_SIZE}`);
    await env.BUCKET.delete(R2_KEY_PERF_TASK);
    task = { toProcess, results: [] };
  } else {
    const obj = await env.BUCKET.get(R2_KEY_PERF_TASK);
    if (!obj) return { error: 'No task found', done: true };
    task = JSON.parse(await obj.text());
  }

  const batch = task.toProcess.slice(offset, offset + PERF_BATCH_SIZE);
  console.log(`Performance scan batch: offset=${offset}, batchSize=${batch.length}, total=${task.toProcess.length}`);

  const batchResults = await Promise.allSettled(
    batch.map(ds => benchmarkDataset(ds))
  );

  for (let i = 0; i < batchResults.length; i++) {
    const r = batchResults[i];
    if (r.status === 'fulfilled' && r.value) {
      task.results.push(r.value);
    } else {
      task.results.push({
        datasetId: batch[i].id,
        metrics: [],
        overall: 'F',
        error: r.reason?.message || 'Unknown error',
      });
    }
  }

  const nextOffset = offset + PERF_BATCH_SIZE;
  const done = nextOffset >= task.toProcess.length;

  if (!done) {
    await env.BUCKET.put(R2_KEY_PERF_TASK, JSON.stringify(task));
  }

  // Grade distribution for logging
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0, F: 0, 'N/A': 0 };
  task.results.forEach(r => { gradeCounts[r.overall] = (gradeCounts[r.overall] || 0) + 1; });

  const output = {
    generated: new Date().toISOString(),
    totalChecked: task.toProcess.length,
    thresholds: PERF_THRESHOLDS,
    gradeLabels: Object.fromEntries(GRADE_LETTERS.map((g, i) => [g, GRADE_LABELS[i]])),
    datasets: task.results,
    _scanComplete: done,
  };

  await env.BUCKET.put(R2_KEY_PERF, JSON.stringify(output, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  if (done) {
    await env.BUCKET.delete(R2_KEY_PERF_TASK);
    console.log(`Performance scan complete: A=${gradeCounts.A} B=${gradeCounts.B} C=${gradeCounts.C} D=${gradeCounts.D} F=${gradeCounts.F}`);
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
