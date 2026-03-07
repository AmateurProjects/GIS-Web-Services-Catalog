#!/usr/bin/env node
'use strict';

/**
 * generate-freshness.js
 *
 * Detects "last updated" dates for every ArcGIS REST dataset in catalog.json
 * using a multi-signal approach. Results are saved as data/freshness.json.
 *
 * Signals (in priority order):
 *   1. editingInfo.lastEditDate (layer-level)
 *   2. Editor tracking date fields (MAX query)
 *   3. Common date field heuristics (MAX query)
 *   4. Record count delta (compared to stored baseline)
 *   5. Metadata text parsing
 *   6. Any remaining date field fallback (low confidence)
 *
 * Usage:
 *   node scripts/generate-freshness.js             # dry-run
 *   node scripts/generate-freshness.js --write      # write data/freshness.json
 *   node scripts/generate-freshness.js --force      # re-check all, ignore cache
 *   node scripts/generate-freshness.js --dataset <id>
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const SERVICE_INFO_DIR = path.join(__dirname, '..', 'data', 'service-info');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'freshness.json');

const TIMEOUT_MS = 12000;
const CONCURRENCY = 3;
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2000;

const args = process.argv.slice(2);
const doWrite = args.includes('--write');
const forceAll = args.includes('--force');
const dsArgIdx = args.indexOf('--dataset');
const targetId = dsArgIdx >= 0 ? args[dsArgIdx + 1] : null;

// ── HTTP ──

function fetchJson(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, timeout).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchRetry(fn) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); }
    catch (e) { if (i >= MAX_RETRIES) throw e; await sleep(RETRY_DELAY_MS); }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeUrl(url) { return (url || '').trim().replace(/\/+$/, ''); }

function parseServiceUrl(url) {
  const m = url.match(/(.*\/(?:MapServer|FeatureServer|ImageServer))(?:\/(\d+))?/i);
  if (!m) return null;
  return { base: m[1], layerId: m[2] !== undefined ? Number(m[2]) : null };
}

function isImageServer(url) {
  return String(url || '').toUpperCase().includes('/IMAGESERVER');
}

// ── Date field detection patterns ──

const EDIT_DATE_PATTERNS = [
  /^last_edit(ed)?_date$/i, /^edit_date$/i, /^edited_date$/i,
  /^modif(y|ied)_date$/i, /^last_modif(y|ied)$/i, /^update_date$/i,
  /^last_update(d)?$/i, /^date_updated$/i, /^date_modif(y|ied)$/i,
];

function dateFieldPriority(name) {
  const n = name.toUpperCase();
  if (/LAST.?EDIT/.test(n) || /EDIT.?DATE/.test(n)) return 0;
  if (/^MODIFIED$/i.test(name) || /MODIF/.test(n) || /UPDATE/.test(n)) return 1;
  if (/^CREATED$/i.test(name) || /CREATE/.test(n)) return 2;
  return 3;
}

// ── MAX date query ──

async function queryMaxDate(target, fieldName) {
  const params = new URLSearchParams({
    where: '1=1',
    outStatistics: JSON.stringify([
      { statisticType: 'max', onStatisticField: fieldName, outStatisticFieldName: 'max_date' }
    ]),
    f: 'json',
  });
  const json = await fetchRetry(() => fetchJson(`${target}/query?${params}`, TIMEOUT_MS));
  const val = json?.features?.[0]?.attributes?.max_date;
  if (val == null) return null;
  if (typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// ── Process a single dataset ──

async function processDataset(ds, storedRecordCount) {
  const url = normalizeUrl(ds.public_web_service);
  const parsed = parseServiceUrl(url);
  if (!parsed) return null;

  const _isImageSvc = isImageServer(url);
  const isLayerUrl = parsed.layerId !== null;

  // For ImageServer: no sublayers, use service URL directly.
  // For Map/FeatureServer without an explicit layer: discover the real first layer ID.
  let layerId;
  let queryTarget;

  if (_isImageSvc) {
    layerId = null;
    queryTarget = parsed.base;
  } else if (isLayerUrl) {
    layerId = parsed.layerId;
    queryTarget = url;
  } else {
    // Discover the first layer ID from the service endpoint
    try {
      const svcJson = await fetchRetry(() => fetchJson(`${parsed.base}?f=pjson`, TIMEOUT_MS));
      layerId = (svcJson && svcJson.layers && svcJson.layers.length)
        ? (svcJson.layers[0].id ?? 0)
        : 0;
    } catch (_) {
      layerId = 0;
    }
    queryTarget = `${parsed.base}/${layerId}`;
  }

  const signals = [];

  // Load cached service-info for field list (avoid re-fetching)
  let cachedFields = [];
  let cachedEditFieldsInfo = null;
  const infoPath = path.join(SERVICE_INFO_DIR, `${ds.id}.json`);
  if (fs.existsSync(infoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      cachedFields = info.fields || [];
      cachedEditFieldsInfo = info.metadata?.editFieldsInfo;
    } catch (_) {}
  }

  // ── Fetch layer JSON for editingInfo ──
  let layerJson = null;
  try {
    layerJson = await fetchRetry(() => fetchJson(`${queryTarget}?f=pjson`, TIMEOUT_MS));
  } catch (e) {
    signals.push({ signal: 'layer_fetch', value: null, confidence: 'none', detail: `Could not reach layer: ${e.message}` });
    return { datasetId: ds.id, signals, lastUpdated: null, signal: 'none', confidence: 'none', details: 'Service unreachable', recordCount: null };
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
  // Skip for ImageServer — no /query endpoint
  const trackingField = layerJson?.editFieldsInfo?.editDateField || layerJson?.editFieldsInfo?.lastEditDateField;
  if (_isImageSvc) {
    signals.push({ signal: 'editor_tracking', value: null, confidence: 'none', detail: 'Skipped — ImageServer has no query endpoint' });
  } else if (trackingField) {
    try {
      const maxDate = await queryMaxDate(queryTarget, trackingField);
      signals.push(maxDate
        ? { signal: 'editor_tracking', value: maxDate, confidence: 'high', detail: `MAX(${trackingField}) = ${maxDate}` }
        : { signal: 'editor_tracking', value: null, confidence: 'none', detail: `${trackingField} returned no data` }
      );
    } catch (e) {
      signals.push({ signal: 'editor_tracking', value: null, confidence: 'none', detail: e.message });
    }
  } else {
    signals.push({ signal: 'editor_tracking', value: null, confidence: 'none', detail: 'No editor tracking' });
  }

  // ── Signal 3: Date field heuristic ──
  // Skip for ImageServer — no /query endpoint
  // Compute dateFields for use by both Signal 3 and Signal 6
  const fields = _isImageSvc ? [] : (layerJson?.fields || cachedFields);
  const dateFields = _isImageSvc ? [] : fields
    .filter(f => (f.type || '').toUpperCase().includes('DATE'))
    .filter(f => f.name !== trackingField)
    .sort((a, b) => dateFieldPriority(a.name) - dateFieldPriority(b.name));

  if (_isImageSvc) {
    signals.push({ signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'Skipped — ImageServer has no query endpoint' });
  } else {

  if (dateFields.length > 0) {
    const candidates = dateFields.slice(0, 3);
    let bestDate = null;
    let bestField = null;

    for (const f of candidates) {
      try {
        const maxDate = await queryMaxDate(queryTarget, f.name);
        if (maxDate) {
          const d = new Date(maxDate);
          if (!isNaN(d.getTime()) && (!bestDate || d > new Date(bestDate))) {
            bestDate = maxDate;
            bestField = f.name;
          }
        }
      } catch (_) {}
    }

    const priority = bestField ? dateFieldPriority(bestField) : 4;
    // Modification/edit fields → high, creation fields → medium, others → low
    const conf = priority <= 1 ? 'high' : priority <= 2 ? 'medium' : 'low';
    signals.push(bestDate
      ? { signal: 'date_field_heuristic', value: bestDate, confidence: conf, detail: `MAX(${bestField}) = ${bestDate}` }
      : { signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'No dates found' }
    );
  } else {
    signals.push({ signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'No date fields' });
  }
  } // end else (non-ImageServer) for Signal 3

  // ── Signal 4: Record count delta ──
  // Skip for ImageServer — no /query endpoint
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
    if (parsed && !isNaN(parsed.getTime())) {
      signals.push({ signal: 'metadata_text', value: parsed.toISOString(), confidence: 'medium', detail: `Found "${kwMatch[0].trim()}"` });
      metaSignalPushed = true;
    }
  }
  if (!metaSignalPushed) {
    const dateOnly = allText.match(new RegExp(DATE_RE, 'i'));
    if (dateOnly) {
      const parsed = parseMetaDate(dateOnly[1]);
      if (parsed && !isNaN(parsed.getTime())) {
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
            if (!isNaN(d.getTime()) && (!bestDate || d > new Date(bestDate))) {
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
  const ranked = signals.filter(s => s.value !== null && s.confidence !== 'none')
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

// ── Main ──

async function main() {
  console.log('=== Freshness Detector ===');
  console.log(`  Mode: ${doWrite ? 'WRITE' : 'DRY-RUN'}\n`);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const datasets = catalog.datasets || [];

  // Load existing freshness data for record count baselines
  let existing = {};
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
      (prev.datasets || []).forEach(d => { existing[d.datasetId] = d; });
    } catch (_) {}
  }

  const toProcess = datasets.filter(ds => {
    if (!ds.public_web_service) return false;
    if (!/\/rest\/services\//i.test(ds.public_web_service)) return false;
    if (targetId && ds.id !== targetId) return false;
    if (!forceAll && existing[ds.id] && existing[ds.id].confidence === 'high') return false;
    return true;
  });

  console.log(`  ${toProcess.length} datasets to check\n`);
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < toProcess.length) {
      const i = idx++;
      const ds = toProcess[i];
      const stored = existing[ds.id];
      const storedCount = stored?.recordCount ?? null;

      console.log(`  [${i + 1}/${toProcess.length}] ${ds.id}`);
      try {
        const result = await processDataset(ds, storedCount);
        if (result) {
          results.push(result);
          const age = result.lastUpdated ? timeSince(result.lastUpdated) : 'unknown';
          console.log(`    ${result.confidence.toUpperCase()} — ${age} (${result.signal})`);
        }
      } catch (e) {
        console.log(`    ✗ Error: ${e.message}`);
        results.push({ datasetId: ds.id, lastUpdated: null, signal: 'none', confidence: 'none', details: e.message, signals: [], recordCount: null });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Merge with existing data for datasets we didn't re-check
  datasets.forEach(ds => {
    if (!results.find(r => r.datasetId === ds.id) && existing[ds.id]) {
      results.push(existing[ds.id]);
    }
  });

  const output = {
    generated: new Date().toISOString(),
    totalChecked: toProcess.length,
    datasets: results,
  };

  // Stats
  const confCounts = { high: 0, medium: 0, low: 0, none: 0 };
  results.forEach(r => confCounts[r.confidence]++);
  console.log(`\n=== Results ===`);
  console.log(`  High confidence:   ${confCounts.high}`);
  console.log(`  Medium confidence:  ${confCounts.medium}`);
  console.log(`  Low confidence:     ${confCounts.low}`);
  console.log(`  Unknown:            ${confCounts.none}`);

  const fresh90 = results.filter(r => {
    if (!r.lastUpdated) return false;
    return (new Date() - new Date(r.lastUpdated)) < 90 * 24 * 3600 * 1000;
  }).length;
  const stale365 = results.filter(r => {
    if (!r.lastUpdated) return false;
    return (new Date() - new Date(r.lastUpdated)) > 365 * 24 * 3600 * 1000;
  }).length;
  console.log(`  Updated < 90 days:  ${fresh90}`);
  console.log(`  Updated > 1 year:   ${stale365}`);

  if (doWrite) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n✅ Wrote ${OUTPUT_PATH}`);
  } else {
    console.log('\nDry run — pass --write to save.');
  }
}

function timeSince(iso) {
  const d = new Date(iso);
  const days = Math.floor((new Date() - d) / (1000 * 60 * 60 * 24));
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

main().catch(e => { console.error(e); process.exit(1); });
