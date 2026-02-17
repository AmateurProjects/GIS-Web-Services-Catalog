#!/usr/bin/env node
'use strict';

/**
 * generate-service-info.js
 *
 * Pre-fetches ArcGIS REST service metadata, field definitions (with
 * null %/distinct counts), and sample records for every dataset in
 * catalog.json that has a valid ArcGIS REST web service URL.
 *
 * Results are saved as individual JSON files in data/service-info/<id>.json
 * so the front-end can render the Service Metadata, Fields, and Sample
 * Records cards instantly without live REST queries.
 *
 * Intended to run weekly via GitHub Actions, or manually.
 *
 * Usage:
 *   node scripts/generate-service-info.js                  # Dry-run (preview only)
 *   node scripts/generate-service-info.js --write           # Write results to data/service-info/
 *   node scripts/generate-service-info.js --force           # Re-process datasets that already have cached info
 *   node scripts/generate-service-info.js --dataset <id>    # Process only a specific dataset
 *   node scripts/generate-service-info.js --write --force   # Full refresh + write
 *   node scripts/generate-service-info.js --help            # Show usage
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'service-info');

const TIMEOUT_MS = 15000;          // per-request timeout
const DATASET_CONCURRENCY = 2;     // datasets processed in parallel
const FIELD_STAT_CONCURRENCY = 3;  // field stat queries in parallel per dataset
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const SAMPLE_ROW_COUNT = 5;

// ── CLI Arguments ──────────────────────────────────────────────────────────

const USAGE = `
Usage:
  node scripts/generate-service-info.js [options]

Options:
  --write           Write results to data/service-info/ (default: dry-run)
  --force           Re-process datasets that already have cached info
  --dataset <id>    Process only a specific dataset
  --help            Show this help message

Examples:
  node scripts/generate-service-info.js                  # Preview what would change
  node scripts/generate-service-info.js --write           # Generate & save service info
  node scripts/generate-service-info.js --dataset blm_acec --write
  node scripts/generate-service-info.js --force --write   # Full refresh + write
`.trim();

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const doWrite = args.includes('--write');
const forceAll = args.includes('--force');
const datasetArgIdx = args.indexOf('--dataset');
const targetDatasetId = datasetArgIdx >= 0 ? args[datasetArgIdx + 1] : null;

// ── HTTP Utilities ─────────────────────────────────────────────────────────

function fetchJson(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, timeout).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

async function fetchWithRetry(fn, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      const delay = RETRY_DELAY_MS * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── URL Utilities ──────────────────────────────────────────────────────────

function normalizeUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function parseServiceUrl(url) {
  const match = url.match(/(.*\/(?:MapServer|FeatureServer|ImageServer))(?:\/(\d+))?/i);
  if (!match) return null;
  return { base: match[1], layerId: match[2] !== undefined ? Number(match[2]) : null };
}

function looksLikeArcGisService(url) {
  return /\/rest\/services\/.*\/(MapServer|FeatureServer|ImageServer)/i.test(url || '');
}

// ── ArcGIS REST Fetchers ───────────────────────────────────────────────────

async function fetchServiceJson(serviceUrl) {
  const base = normalizeUrl(serviceUrl);
  const u = base.includes('?') ? `${base}&f=pjson` : `${base}?f=pjson`;
  return fetchWithRetry(() => fetchJson(u));
}

async function fetchLayerJson(serviceUrl, layerId) {
  const base = normalizeUrl(serviceUrl);
  const parsed = parseServiceUrl(base);
  const target = parsed && parsed.layerId !== null ? base : `${base}/${layerId}`;
  const u = `${target}?f=pjson`;
  return fetchWithRetry(() => fetchJson(u));
}

async function fetchRecordCount(target) {
  const params = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
  const json = await fetchWithRetry(() => fetchJson(`${target}/query?${params}`, TIMEOUT_MS));
  if (json && typeof json.count === 'number') return json.count;
  return null;
}

async function fetchSampleRows(target, n = SAMPLE_ROW_COUNT) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'false',
    resultRecordCount: String(n),
    f: 'json',
  });
  const json = await fetchWithRetry(() => fetchJson(`${target}/query?${params}`, TIMEOUT_MS));
  if (json && Array.isArray(json.features)) {
    return json.features.map(f => f.attributes).filter(Boolean);
  }
  return [];
}

// ── Field Statistics ───────────────────────────────────────────────────────

async function computeFieldStats(target, fields, totalCount) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < fields.length) {
      const i = idx++;
      const f = fields[i];

      const ft = (f.type || '').toUpperCase();
      if (ft.includes('GEOMETRY') || ft.includes('BLOB') || ft.includes('RASTER') || ft.includes('XML')) {
        results[i] = { name: f.name, type: f.type, alias: f.alias || '', nullPct: null, distinctCount: null, skipped: true };
        continue;
      }

      let nullPct = null;
      let distinctCount = null;

      // Non-null count → null %
      try {
        const statParams = new URLSearchParams({
          where: '1=1',
          outStatistics: JSON.stringify([
            { statisticType: 'count', onStatisticField: f.name, outStatisticFieldName: 'nn_count' }
          ]),
          f: 'json',
        });
        const statJson = await fetchWithRetry(() => fetchJson(`${target}/query?${statParams}`, TIMEOUT_MS));
        const nnCount = statJson?.features?.[0]?.attributes?.nn_count;
        if (nnCount != null && totalCount > 0) {
          nullPct = Number(((totalCount - nnCount) / totalCount * 100).toFixed(1));
        }
      } catch {}

      // Distinct count
      try {
        // Approach 1: returnDistinctValues + returnCountOnly
        const distParams = new URLSearchParams({
          where: '1=1',
          outFields: f.name,
          returnDistinctValues: 'true',
          returnCountOnly: 'true',
          f: 'json',
        });
        const distJson = await fetchWithRetry(() => fetchJson(`${target}/query?${distParams}`, TIMEOUT_MS));
        if (distJson && typeof distJson.count === 'number') {
          distinctCount = distJson.count;
        }
      } catch {}

      // Approach 2 fallback: groupByFieldsForStatistics
      if (distinctCount === null) {
        try {
          const distParams2 = new URLSearchParams({
            where: '1=1',
            groupByFieldsForStatistics: f.name,
            outStatistics: JSON.stringify([
              { statisticType: 'count', onStatisticField: f.name, outStatisticFieldName: 'cnt' }
            ]),
            f: 'json',
          });
          const distJson2 = await fetchWithRetry(() => fetchJson(`${target}/query?${distParams2}`, TIMEOUT_MS));
          if (distJson2 && Array.isArray(distJson2.features)) {
            distinctCount = distJson2.features.length;
          }
        } catch {}
      }

      results[i] = {
        name: f.name,
        type: f.type,
        alias: f.alias || '',
        nullPct,
        distinctCount,
        hasDomain: !!(f.domain && f.domain.type === 'codedValue'),
      };
    }
  }

  await Promise.all(Array.from({ length: FIELD_STAT_CONCURRENCY }, worker));
  return results.filter(Boolean);
}

// ── Process a Single Dataset ───────────────────────────────────────────────

async function processDataset(dataset) {
  const url = normalizeUrl(dataset.public_web_service);
  const parsed = parseServiceUrl(url);
  if (!parsed) {
    console.log('    ✗ Could not parse ArcGIS REST URL');
    return null;
  }

  const serviceBaseUrl = parsed.base;
  const isLayerUrl = parsed.layerId !== null;

  // 1. Fetch service JSON
  let serviceJson;
  try {
    serviceJson = await fetchServiceJson(serviceBaseUrl);
  } catch {
    try { serviceJson = await fetchServiceJson(url); } catch { return null; }
  }
  if (!serviceJson) return null;

  // 2. Determine layer ID
  let layerId;
  if (isLayerUrl) {
    layerId = parsed.layerId;
  } else {
    layerId = (serviceJson.layers && serviceJson.layers.length)
      ? (serviceJson.layers[0].id ?? 0)
      : 0;
  }

  const fetchBaseUrl = isLayerUrl ? url : serviceBaseUrl;
  const queryTarget = isLayerUrl ? fetchBaseUrl : `${fetchBaseUrl}/${layerId}`;

  // 3. Fetch layer JSON
  let layerJson = null;
  try { layerJson = await fetchLayerJson(fetchBaseUrl, layerId); } catch {}
  if ((!layerJson || !Array.isArray(layerJson.fields)) && isLayerUrl) {
    try {
      const direct = await fetchServiceJson(url);
      if (direct && Array.isArray(direct.fields)) layerJson = direct;
    } catch {}
  }

  // 4. Record count
  let recordCount = null;
  try { recordCount = await fetchRecordCount(queryTarget); } catch {}
  console.log(`    Record count: ${recordCount !== null ? recordCount.toLocaleString() : 'unknown'}`);

  // 5. Build service metadata object
  const documentInfo = serviceJson.documentInfo || {};
  const spatialRef = serviceJson.spatialReference || layerJson?.spatialReference || {};
  const extent = layerJson?.extent || serviceJson.fullExtent || null;

  const metadata = {
    serviceDescription: serviceJson.serviceDescription || serviceJson.description || '',
    copyrightText: serviceJson.copyrightText || '',
    author: documentInfo.Author || '',
    subject: documentInfo.Subject || '',
    keywords: documentInfo.Keywords || '',
    comments: documentInfo.Comments || '',
    currentVersion: serviceJson.currentVersion || '',
    maxRecordCount: serviceJson.maxRecordCount || '',
    wkid: spatialRef.latestWkid || spatialRef.wkid || '',
    capabilities: serviceJson.capabilities || '',
    syncEnabled: serviceJson.syncEnabled ?? null,
    supportedQueryFormats: layerJson?.supportedQueryFormats || serviceJson.supportedQueryFormats || '',
    // Layer-level
    layerName: layerJson?.name || '',
    layerType: layerJson?.type || '',
    geometryType: layerJson?.geometryType || '',
    objectIdField: layerJson?.objectIdField || '',
    globalIdField: layerJson?.globalIdField || '',
    displayField: layerJson?.displayField || '',
    supportsStatistics: layerJson?.supportsStatistics ?? serviceJson.supportsStatistics ?? null,
    supportsAdvancedQueries: layerJson?.advancedQueryCapabilities?.supportsAdvancedQueries ?? null,
    hasAttachments: layerJson?.hasAttachments ?? null,
    hasZ: layerJson?.hasZ ?? null,
    hasM: layerJson?.hasM ?? null,
    minScale: layerJson?.minScale || 0,
    maxScale: layerJson?.maxScale || 0,
    editFieldsInfo: layerJson?.editFieldsInfo ? true : false,
    featureCount: layerJson?.featureCount ?? null,
    lastEditDate: layerJson?.editingInfo?.lastEditDate || serviceJson.editingInfo?.lastEditDate || null,
    definitionExpression: layerJson?.definitionExpression || '',
    recordCount,
    extent: extent ? {
      xmin: extent.xmin,
      ymin: extent.ymin,
      xmax: extent.xmax,
      ymax: extent.ymax,
    } : null,
  };

  // 6. Fields (definitions + stats)
  let fields = [];
  let fieldStats = [];
  if (layerJson && Array.isArray(layerJson.fields) && layerJson.fields.length) {
    fields = layerJson.fields.map(f => ({
      name: f.name,
      alias: f.alias || '',
      type: f.type || '',
      domain: f.domain && f.domain.type === 'codedValue' ? {
        type: 'codedValue',
        codedValueCount: f.domain.codedValues ? f.domain.codedValues.length : 0,
      } : null,
    }));

    // Key / system fields
    const oidFieldName = (layerJson.objectIdField || '').toUpperCase();
    const globalIdFieldName = (layerJson.globalIdField || '').toUpperCase();
    fields.forEach(f => {
      const n = (f.name || '').toUpperCase();
      const t = (f.type || '').toUpperCase();
      f.isKey = n === oidFieldName || n === globalIdFieldName
        || t === 'ESRIFIELDTYPEOID' || t === 'ESRIFIELDTYPEGLOBALID';
    });

    // Compute field stats (null %, distinct count)
    if (recordCount && recordCount > 0) {
      console.log(`    Computing field stats for ${fields.length} fields...`);
      fieldStats = await computeFieldStats(queryTarget, layerJson.fields, recordCount);
      console.log(`    Field stats computed.`);
    }
  }

  // 7. Sample rows
  let sampleRows = [];
  try {
    sampleRows = await fetchSampleRows(queryTarget, SAMPLE_ROW_COUNT);
    console.log(`    Fetched ${sampleRows.length} sample rows`);
  } catch {
    console.log(`    Could not fetch sample rows`);
  }

  return {
    generated: new Date().toISOString(),
    datasetId: dataset.id,
    serviceUrl: url,
    metadata,
    fields,
    fieldStats,
    sampleRows,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Service Info Generator ===');
  console.log(`  Mode: ${doWrite ? 'WRITE' : 'DRY-RUN (use --write to save)'}`);
  if (forceAll) console.log('  Force: re-processing all datasets');
  if (targetDatasetId) console.log(`  Target dataset: ${targetDatasetId}`);
  console.log('');

  // 1. Load catalog
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(raw);
  const datasets = catalog.datasets || [];
  console.log(`  Loaded ${datasets.length} datasets from catalog.json`);

  // 2. Ensure output directory exists
  if (doWrite && !fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`  Created ${OUTPUT_DIR}`);
  }

  // 3. Filter datasets to process
  const toProcess = datasets.filter(ds => {
    if (!ds.public_web_service || !looksLikeArcGisService(ds.public_web_service)) return false;
    if (targetDatasetId && ds.id !== targetDatasetId) return false;
    if (!forceAll) {
      const infoPath = path.join(OUTPUT_DIR, `${ds.id}.json`);
      if (fs.existsSync(infoPath)) return false;
    }
    return true;
  });

  console.log(`  ${toProcess.length} dataset(s) to process\n`);

  if (!toProcess.length) {
    console.log('  Nothing to do.');
    return;
  }

  // 4. Process datasets with concurrency pool
  let dsIdx = 0;
  let processed = 0;
  let succeeded = 0;
  let errored = 0;

  const dsWorkers = Array.from({ length: DATASET_CONCURRENCY }, async () => {
    while (dsIdx < toProcess.length) {
      const i = dsIdx++;
      const ds = toProcess[i];

      console.log(`  [${i + 1}/${toProcess.length}] ${ds.id}`);
      console.log(`    ${ds.title || ''}`);
      console.log(`    ${ds.public_web_service}`);

      try {
        const info = await processDataset(ds);
        if (info) {
          if (doWrite) {
            const outPath = path.join(OUTPUT_DIR, `${ds.id}.json`);
            fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n', 'utf8');
            console.log(`    ✓ Written to ${outPath}`);
          } else {
            console.log(`    ✓ Would write ${ds.id}.json (${info.fields.length} fields, ${info.sampleRows.length} samples)`);
          }
          succeeded++;
        } else {
          console.log(`    ✗ No data returned`);
          errored++;
        }
      } catch (e) {
        console.log(`    ✗ Error: ${e.message}`);
        errored++;
      }
      processed++;
      console.log('');
    }
  });

  await Promise.all(dsWorkers);

  // 5. Summary
  console.log('=== Summary ===');
  console.log(`  Processed : ${processed}`);
  console.log(`  Succeeded : ${succeeded}`);
  console.log(`  Errors    : ${errored}`);

  if (!doWrite && succeeded > 0) {
    console.log('\n  Dry-run complete. Use --write to save results.');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
