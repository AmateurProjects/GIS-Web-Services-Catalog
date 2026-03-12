// ====== URL STATUS CHECK HELPERS ======
export const URL_CHECK = {
  timeoutMs: 12000,
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

// Detect ImageServer URLs (raster/imagery — no /query endpoint)
function isImageServerUrl(url) {
  return String(url || '').toUpperCase().includes('/IMAGESERVER');
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
 * Strategy:
 *  1. Fetch metadata JSON (?f=pjson) for the target URL — if valid, service IS alive
 *  2. Determine a queryable layer (skip group layers, check capabilities)
 *  3. Best-effort count query — enriches detail but does not gate the status
 *
 * A service is only marked 'bad' when the endpoint is unreachable or returns an
 * ArcGIS error. Query failures on a confirmed-alive service still yield 'ok'.
 *
 * Returns: { status: "ok"|"bad"|"unknown", detail: string }
 */
async function checkArcGisServiceHealth(url) {
  const parsed = parseArcGisUrl(url);
  if (!parsed) return { status: 'bad', detail: 'Could not parse ArcGIS REST URL' };

  const serviceBase = parsed.base;
  const isLayerUrl = parsed.layerId !== null;
  const cleanUrl = url.replace(/\?.*$/, '');

  // Step 1: Fetch metadata for the target URL (layer or service root)
  // Layer URLs → fetch layer JSON directly (gives type, fields, capabilities)
  // Service roots → fetch service JSON (gives layers list, capabilities, version)
  let metaJson;
  try {
    const metaUrl = isLayerUrl
      ? (cleanUrl.includes('?') ? `${cleanUrl}&f=pjson` : `${cleanUrl}?f=pjson`)
      : (serviceBase.includes('?') ? `${serviceBase}&f=pjson` : `${serviceBase}?f=pjson`);
    metaJson = await fetchJsonTimeout(metaUrl, URL_CHECK.timeoutMs);
  } catch (e) {
    return { status: 'bad', detail: `Service endpoint unreachable: ${e.message}` };
  }

  // ArcGIS error response (token required, forbidden, service not found, etc.)
  if (metaJson && metaJson.error) {
    const code = metaJson.error.code || '';
    const msg = metaJson.error.message || 'Service error';
    return { status: 'bad', detail: `Service error (${code}): ${msg}` };
  }

  // Validate that the response is genuine ArcGIS REST metadata
  const hasServiceFields = metaJson && (metaJson.currentVersion || metaJson.layers || metaJson.serviceDescription != null || metaJson.mapName);
  const hasLayerFields = metaJson && (metaJson.type || metaJson.fields || (metaJson.name && metaJson.id != null));
  if (!hasServiceFields && !hasLayerFields) {
    return { status: 'bad', detail: 'Response is not valid ArcGIS service metadata' };
  }

  // ── Service is confirmed alive ──
  // Query failures below yield 'ok' with descriptive detail, never 'bad' or 'unknown'.

  // Step 2: ImageServer — metadata alone confirms health
  if (isImageServerUrl(url)) {
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
      queryTarget = `${serviceBase}/${layer.id}`;
      break;
    }
    // All top-level entries are groups — try first sublayer of first group
    if (!queryTarget && layers.length > 0 && Array.isArray(layers[0].subLayerIds) && layers[0].subLayerIds.length > 0) {
      queryTarget = `${serviceBase}/${layers[0].subLayerIds[0]}`;
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
      const countJson = await fetchJsonTimeout(`${queryTarget}/query?${countParams}`, URL_CHECK.timeoutMs);

      if (countJson && !countJson.error && typeof countJson.count === 'number') {
        if (countJson.count > 0) {
          return { status: 'ok', detail: `Serving data (${countJson.count.toLocaleString()} features)` };
        }
        return { status: 'ok', detail: 'Service responding (0 features — layer may be empty or scale-filtered)' };
      }
      // Query returned ArcGIS error — service metadata is alive but queries fail
      if (countJson && countJson.error) {
        const qCode = countJson.error.code || '';
        const qMsg = countJson.error.message || 'Query failed';
        return { status: 'bad', detail: `Metadata alive but query failed (${qCode}): ${qMsg}` };
      }
      // Unexpected response format — queries not working as expected
      return { status: 'bad', detail: 'Metadata alive but query returned unexpected response' };
    } catch (queryErr) {
      // Query timed out or network error — service may be overloaded or partially down
      return { status: 'bad', detail: `Metadata alive but query failed: ${queryErr.message}` };
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
    // Retry once for transient failures (slow government servers, timeouts)
    if (result.status !== 'ok') {
      await new Promise(r => setTimeout(r, 2000));
      result = await checkArcGisServiceHealth(url);
    }
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
    // Retry once for transient failures (slow government servers, timeouts)
    if (result.status !== 'ok') {
      await new Promise(r => setTimeout(r, 2000));
      result = await checkArcGisServiceHealth(url);
    }
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
