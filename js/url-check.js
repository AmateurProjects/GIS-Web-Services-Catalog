// ====== URL STATUS CHECK HELPERS ======
export const URL_CHECK = {
  timeoutMs: 8000,
  concurrency: 3,
};

// Cache URL check results with a 5-minute TTL
// url -> { status: "ok"|"bad"|"unknown", ts: number, detail: string }
const urlStatusCache = new Map();
const URL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getCachedUrlStatus(url) {
  if (!url) return null;
  const entry = urlStatusCache.get(url);
  if (!entry) return null;
  // Expire stale entries
  if (Date.now() - entry.ts > URL_CACHE_TTL_MS) {
    urlStatusCache.delete(url);
    return null;
  }
  return entry;
}

export function setCachedUrlStatus(url, status, detail) {
  if (!url) return;
  urlStatusCache.set(url, { status, ts: Date.now(), detail: detail || '' });
}

export function setUrlStatus(rowEl, status, titleText) {
  if (!rowEl) return;
  rowEl.setAttribute('data-url-status', status);
  const icon = rowEl.querySelector('.url-status-icon');
  if (icon) icon.title = titleText || '';
}

// Detect ArcGIS REST service URLs
function isArcGisRestUrl(url) {
  const u = String(url || '').toUpperCase();
  return u.includes('/REST/SERVICES/') && (u.includes('/MAPSERVER') || u.includes('/FEATURESERVER') || u.includes('/IMAGESERVER'));
}

// Parse ArcGIS service URL into base + optional layer ID
function parseArcGisUrl(url) {
  const match = url.match(/(.*\/(?:MapServer|FeatureServer|ImageServer))(?:\/(\d+))?/i);
  if (!match) return null;
  return { base: match[1], layerId: match[2] !== undefined ? Number(match[2]) : null };
}

// Fetch JSON with timeout (for ArcGIS health checks)
async function fetchJsonTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Deep health check for ArcGIS REST services.
 *
 * Steps:
 *  1. Fetch service JSON (?f=pjson) — confirms endpoint exists and returns valid JSON
 *  2. Determine the query target layer (explicit layerId or first sublayer)
 *  3. Query returnCountOnly — confirms the service actually serves feature data
 *
 * Returns: { status: "ok"|"bad"|"unknown", detail: string }
 */
async function checkArcGisServiceHealth(url) {
  const parsed = parseArcGisUrl(url);
  if (!parsed) return { status: 'bad', detail: 'Could not parse ArcGIS REST URL' };

  const serviceBase = parsed.base;
  const isLayerUrl = parsed.layerId !== null;

  // Step 1: Fetch service/layer JSON
  let serviceJson;
  try {
    const pjsonUrl = serviceBase.includes('?')
      ? `${serviceBase}&f=pjson`
      : `${serviceBase}?f=pjson`;
    serviceJson = await fetchJsonTimeout(pjsonUrl, URL_CHECK.timeoutMs);
  } catch (e) {
    return { status: 'bad', detail: `Service endpoint unreachable: ${e.message}` };
  }

  // Check for ArcGIS REST error responses
  if (serviceJson && serviceJson.error) {
    const code = serviceJson.error.code || '';
    const msg = serviceJson.error.message || 'Service error';
    return { status: 'bad', detail: `Service error (${code}): ${msg}` };
  }

  // Step 2: Determine query target
  let queryTarget;
  if (isLayerUrl) {
    queryTarget = url.replace(/\?.*$/, ''); // strip query params
  } else {
    // Find first layer
    const layers = serviceJson.layers || [];
    const firstLayerId = layers.length ? (layers[0].id ?? 0) : 0;
    queryTarget = `${serviceBase}/${firstLayerId}`;
  }

  // Step 3: Query returnCountOnly — the true test of whether the service renders data
  try {
    const countParams = new URLSearchParams({
      where: '1=1',
      returnCountOnly: 'true',
      f: 'json',
    });
    const countJson = await fetchJsonTimeout(`${queryTarget}/query?${countParams}`, URL_CHECK.timeoutMs);

    // Check for error in query response
    if (countJson && countJson.error) {
      const code = countJson.error.code || '';
      const msg = countJson.error.message || 'Query error';
      return { status: 'bad', detail: `Query failed (${code}): ${msg}` };
    }

    if (countJson && typeof countJson.count === 'number') {
      if (countJson.count > 0) {
        return { status: 'ok', detail: `Serving data (${countJson.count.toLocaleString()} features)` };
      } else {
        return { status: 'bad', detail: 'Service responds but contains 0 features' };
      }
    }

    // Response didn't have a count — unusual
    return { status: 'unknown', detail: 'Service responded but count query returned unexpected format' };
  } catch (e) {
    // Service JSON worked but query failed — could be CORS, could be a broken query endpoint
    return { status: 'unknown', detail: `Service metadata reachable but query failed: ${e.message}` };
  }
}

/**
 * Simple reachability check for non-ArcGIS URLs.
 * Uses HEAD then no-cors GET fallback.
 */
async function checkSimpleUrlReachability(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), URL_CHECK.timeoutMs);

  try {
    let resp = await fetch(url, {
      method: 'HEAD',
      mode: 'cors',
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });

    if (resp && typeof resp.status === 'number') {
      const s = (resp.status >= 200 && resp.status < 400) ? 'ok' : 'bad';
      return { status: s, detail: s === 'ok' ? 'URL reachable' : `HTTP ${resp.status}` };
    }
    return { status: 'unknown', detail: 'No readable response' };
  } catch (e1) {
    try {
      let resp2 = await fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        redirect: 'follow',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (resp2 && resp2.type === 'opaque') {
        return { status: 'unknown', detail: 'CORS blocked — cannot verify' };
      }
      if (resp2 && typeof resp2.status === 'number') {
        const s2 = (resp2.status >= 200 && resp2.status < 400) ? 'ok' : 'bad';
        return { status: s2, detail: s2 === 'ok' ? 'URL reachable' : `HTTP ${resp2.status}` };
      }
      return { status: 'unknown', detail: 'No readable response' };
    } catch (e2) {
      return { status: 'bad', detail: `Network error: ${e2.message}` };
    }
  } finally {
    clearTimeout(t);
  }
}

/**
 * Check whether a URL is healthy.
 * For ArcGIS REST services: queries the service to confirm it actually serves feature data.
 * For other URLs: simple HEAD/GET reachability check.
 *
 * Returns: "ok" | "bad" | "unknown"
 */
export async function checkUrlStatus(url) {
  if (!url) return 'bad';
  const cached = getCachedUrlStatus(url);
  if (cached && cached.status) return cached.status;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bad';
  } catch {
    return 'bad';
  }

  let result;
  if (isArcGisRestUrl(url)) {
    result = await checkArcGisServiceHealth(url);
  } else {
    result = await checkSimpleUrlReachability(url);
  }

  setCachedUrlStatus(url, result.status, result.detail);
  return result.status;
}

/**
 * Extended check that returns both status and detail string.
 * Used by dashboard for richer status display.
 */
export async function checkUrlStatusDetailed(url) {
  if (!url) return { status: 'bad', detail: 'No URL' };
  const cached = getCachedUrlStatus(url);
  if (cached && cached.status) return { status: cached.status, detail: cached.detail || '' };
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 'bad', detail: 'Invalid protocol' };
  } catch {
    return { status: 'bad', detail: 'Invalid URL' };
  }

  let result;
  if (isArcGisRestUrl(url)) {
    result = await checkArcGisServiceHealth(url);
  } else {
    result = await checkSimpleUrlReachability(url);
  }

  setCachedUrlStatus(url, result.status, result.detail);
  return result;
}

export async function runUrlChecks(hostEl) {
  if (!hostEl) return;
  const rows = Array.from(hostEl.querySelectorAll('[data-url-check-row]'));
  if (!rows.length) return;

  // If cached, paint immediately. Otherwise mark as checking.
  const toCheck = [];
  rows.forEach((row) => {
    const url = row.getAttribute('data-url') || '';
    if (!url) {
      setUrlStatus(row, 'bad', 'Missing/invalid URL');
      return;
    }
    const cached = getCachedUrlStatus(url);
    if (cached && cached.status) {
      const title =
        cached.status === 'ok'
          ? `Service healthy${cached.detail ? ': ' + cached.detail : ''} (cached)`
          : cached.status === 'bad'
          ? `Service unhealthy${cached.detail ? ': ' + cached.detail : ''} (cached)`
          : `Cannot verify${cached.detail ? ': ' + cached.detail : ''} (cached)`;
      setUrlStatus(row, cached.status, title);
    } else {
      setUrlStatus(row, 'checking', 'Checking service health…');
      toCheck.push(row);
    }
  });

  if (!toCheck.length) return;

  let idx = 0;
  const workers = new Array(URL_CHECK.concurrency).fill(0).map(async () => {
    while (idx < toCheck.length) {
      const row = toCheck[idx++];
      const url = row.getAttribute('data-url') || '';
      const result = await checkUrlStatusDetailed(url);
      if (result.status === 'ok') setUrlStatus(row, 'ok', `Service healthy: ${result.detail}`);
      else if (result.status === 'bad') setUrlStatus(row, 'bad', `Service unhealthy: ${result.detail}`);
      else setUrlStatus(row, 'unknown', `Cannot verify: ${result.detail}`);
    }
  });

  await Promise.all(workers);
}
