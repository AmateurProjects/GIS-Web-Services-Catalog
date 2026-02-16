#!/usr/bin/env node
'use strict';

/**
 * generate-coverage.js
 *
 * Pre-computes state-level coverage data for every spatial dataset in
 * catalog.json by running ArcGIS REST spatial-intersection queries against
 * Census Bureau TIGER state boundaries.
 *
 * Results are stored as `_coverage` on each dataset entry so the front-end
 * can render the coverage map instantly without 51 live queries per dataset.
 *
 * Intended to run on a weekly schedule (GitHub Actions, cron, etc.) or
 * manually when the catalog changes.
 *
 * Usage:
 *   node scripts/generate-coverage.js                       # Dry-run (preview only)
 *   node scripts/generate-coverage.js --write                # Write results to catalog.json
 *   node scripts/generate-coverage.js --force                # Re-process datasets that already have coverage
 *   node scripts/generate-coverage.js --dataset <id>         # Process only a specific dataset
 *   node scripts/generate-coverage.js --write --force        # Full refresh + write
 *   node scripts/generate-coverage.js --help                 # Show usage
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ── Configuration ──────────────────────────────────────────────────────────

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const CENSUS_STATES_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0/query';

const TIMEOUT_MS       = 15000;   // per-request timeout
const CENSUS_TIMEOUT   = 30000;   // Census boundary fetch (large response)
const DATASET_CONCURRENCY = 2;    // datasets processed in parallel
const STATE_CONCURRENCY   = 4;    // states queried in parallel per dataset
const MAX_RETRIES         = 2;    // retries per request
const RETRY_DELAY_MS      = 2000; // base delay between retries

const US_STATE_FIPS = new Set([
  '01','02','04','05','06','08','09','10','11','12','13','15','16','17','18','19','20',
  '21','22','23','24','25','26','27','28','29','30','31','32','33','34','35','36','37',
  '38','39','40','41','42','44','45','46','47','48','49','50','51','53','54','55','56',
]);

const SPATIAL_GEOMETRY_TYPES = new Set([
  'POINT', 'MULTIPOINT', 'POLYLINE', 'POLYGON', 'LINE',
]);

// ── CLI Arguments ──────────────────────────────────────────────────────────

const USAGE = `
Usage:
  node scripts/generate-coverage.js [options]

Options:
  --write           Write results to catalog.json (default: dry-run)
  --force           Re-process datasets that already have coverage data
  --dataset <id>    Process only a specific dataset
  --help            Show this help message

Examples:
  node scripts/generate-coverage.js                  # Preview what would change
  node scripts/generate-coverage.js --write           # Generate & save coverage data
  node scripts/generate-coverage.js --dataset blm_acec --write
  node scripts/generate-coverage.js --force --write   # Rebuild all coverage data
`.trim();

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const doWrite        = args.includes('--write');
const forceAll       = args.includes('--force');
const datasetArgIdx  = args.indexOf('--dataset');
const targetDatasetId = datasetArgIdx >= 0 ? args[datasetArgIdx + 1] : null;

// ── HTTP Utilities ─────────────────────────────────────────────────────────

/**
 * GET a URL and parse the response as JSON.
 * Follows one level of 3xx redirect.
 */
function fetchJson(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, timeout).then(resolve, reject);
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

/**
 * POST form-encoded data to a URL and parse the response as JSON.
 * Used for ArcGIS REST queries where the geometry parameter can be very large.
 */
function postFormJson(urlStr, formData, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const body = new URLSearchParams(formData).toString();

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = mod.request(options, (res) => {
      // Follow redirect as GET
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, timeout).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from POST ${urlStr}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: POST ${urlStr}`)); });
    req.write(body);
    req.end();
  });
}

/**
 * Retry wrapper — calls `fn()` up to `retries` times with exponential backoff.
 */
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

function parseServiceUrl(url) {
  const match = url.match(/(.*\/(?:MapServer|FeatureServer|ImageServer))(?:\/(\d+))?/i);
  if (!match) return null;
  return { base: match[1], layerId: match[2] !== undefined ? Number(match[2]) : null };
}

function looksLikeArcGisService(url) {
  return /\/rest\/services\/.*\/(MapServer|FeatureServer|ImageServer)/i.test(url || '');
}

function normalizeUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

// ── Census State Boundaries ────────────────────────────────────────────────

/**
 * Fetch generalized state boundaries from the Census Bureau TIGERweb service.
 * Returns an array of { fips, name, abbr, geometry } for the 50 states + DC.
 *
 * Uses maxAllowableOffset=0.1 for simplified (smaller) geometries that are
 * still suitable for spatial intersection queries.
 */
async function fetchCensusStates() {
  console.log('  Fetching Census state boundaries...');

  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'STATE,NAME,STUSAB',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '2',
    maxAllowableOffset: '0.1',
    resultRecordCount: '60',
    f: 'json',
  });

  const json = await fetchWithRetry(
    () => fetchJson(`${CENSUS_STATES_URL}?${params}`, CENSUS_TIMEOUT)
  );

  if (!json || !Array.isArray(json.features) || !json.features.length) {
    throw new Error('Census state boundary query returned no features');
  }

  function attr(f, ...keys) {
    for (const k of keys) {
      if (f.attributes[k] !== undefined) return f.attributes[k];
      if (f.attributes[k.toUpperCase()] !== undefined) return f.attributes[k.toUpperCase()];
    }
    return '';
  }

  const states = json.features
    .map(f => ({
      fips: String(attr(f, 'STATE', 'STATEFP', 'GEOID')).padStart(2, '0'),
      name: attr(f, 'NAME'),
      abbr: attr(f, 'STUSAB'),
      geometry: f.geometry,
    }))
    .filter(s => US_STATE_FIPS.has(s.fips) && s.geometry && s.geometry.rings);

  console.log(`  Found ${states.length} state boundaries`);
  return states;
}

// ── Spatial Query ──────────────────────────────────────────────────────────

/**
 * Query the count of features in a dataset layer that intersect a given
 * state polygon. Uses POST to handle large geometry payloads.
 *
 * Note: Unlike the browser version, this does NOT apply a -2 km inward
 * buffer to state polygons (no geometry engine available in plain Node.js).
 * Counts may be slightly higher at state borders due to sliver intersections.
 */
async function queryFeatureCountInState(serviceBase, layerId, stateGeometry) {
  const target = `${serviceBase}/${layerId}/query`;

  const formData = {
    where: '1=1',
    geometry: JSON.stringify(stateGeometry),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    returnCountOnly: 'true',
    f: 'json',
  };

  const json = await postFormJson(target, formData, TIMEOUT_MS);

  if (json && typeof json.count === 'number') {
    return json.count;
  }

  if (json && json.error) {
    throw new Error(json.error.message || `Service error (code ${json.error.code})`);
  }

  return -1;
}

// ── Process a Single Dataset ───────────────────────────────────────────────

async function processDataset(dataset, states) {
  const url = normalizeUrl(dataset.public_web_service);
  const parsed = parseServiceUrl(url);
  if (!parsed) {
    console.log('    ✗ Could not parse ArcGIS REST URL');
    return null;
  }

  const base = parsed.base;
  const layerId = parsed.layerId !== null ? parsed.layerId : 0;

  const stateCounts = {};
  let idx = 0;
  let completed = 0;
  let failed = 0;

  const workers = Array.from({ length: STATE_CONCURRENCY }, async () => {
    while (idx < states.length) {
      const i = idx++;
      const state = states[i];
      try {
        const count = await fetchWithRetry(
          () => queryFeatureCountInState(base, layerId, state.geometry),
          MAX_RETRIES
        );
        stateCounts[state.abbr] = count;
      } catch {
        stateCounts[state.abbr] = -1;
        failed++;
      }
      completed++;
      if (completed % 10 === 0 || completed === states.length) {
        process.stdout.write(
          `\r    ${completed}/${states.length} states queried` +
          (failed > 0 ? ` (${failed} failed)` : '')
        );
      }
    }
  });

  await Promise.all(workers);
  process.stdout.write('\n');

  const statesWithData = Object.values(stateCounts).filter(c => c > 0).length;
  const totalIntersections = Object.values(stateCounts)
    .reduce((sum, c) => sum + Math.max(0, c), 0);

  return {
    generated: new Date().toISOString(),
    statesWithData,
    totalIntersections,
    states: stateCounts,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Coverage Map Generator ===');
  console.log(`  Mode: ${doWrite ? 'WRITE' : 'DRY-RUN (use --write to save)'}`);
  if (forceAll) console.log('  Force: re-processing all datasets');
  if (targetDatasetId) console.log(`  Target dataset: ${targetDatasetId}`);
  console.log('');

  // 1. Load catalog
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(raw);
  const datasets = catalog.datasets || [];
  console.log(`  Loaded ${datasets.length} datasets from catalog.json`);

  // 2. Filter datasets to process
  const toProcess = datasets.filter(ds => {
    // Must have a valid ArcGIS REST URL
    if (!ds.public_web_service || !looksLikeArcGisService(ds.public_web_service)) return false;

    // Must be a spatial geometry type (skip TABLE, RASTER, etc.)
    const geom = (ds.geometry_type || '').toUpperCase();
    if (!SPATIAL_GEOMETRY_TYPES.has(geom)) return false;

    // Filter by target dataset if specified
    if (targetDatasetId && ds.id !== targetDatasetId) return false;

    // Skip datasets that already have coverage data (unless --force)
    if (!forceAll && ds._coverage && ds._coverage.states) return false;

    return true;
  });

  console.log(`  ${toProcess.length} dataset(s) to process\n`);

  if (!toProcess.length) {
    console.log('  Nothing to do.');
    return;
  }

  // 3. Fetch Census state boundaries
  let states;
  try {
    states = await fetchCensusStates();
  } catch (e) {
    console.error('  FATAL: Could not fetch Census state boundaries:', e.message);
    process.exit(1);
  }

  console.log('');

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
        const coverage = await processDataset(ds, states);
        if (coverage) {
          ds._coverage = coverage;
          console.log(
            `    ✓ ${coverage.statesWithData} states with data, ` +
            `${coverage.totalIntersections.toLocaleString()} intersections`
          );
          succeeded++;
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

  // 6. Write results
  if (doWrite && succeeded > 0) {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    console.log(`\n  ✓ Written to ${CATALOG_PATH}`);
  } else if (doWrite && succeeded === 0) {
    console.log('\n  No successful results to write.');
  } else {
    console.log('\n  Dry-run complete. Use --write to save results.');

    // Show preview
    if (succeeded > 0) {
      console.log('\n  Preview of coverage results:');
      toProcess.filter(ds => ds._coverage).slice(0, 5).forEach(ds => {
        const cov = ds._coverage;
        console.log(
          `    ${ds.id}: ${cov.statesWithData} states, ` +
          `${cov.totalIntersections.toLocaleString()} intersections`
        );
      });
      if (succeeded > 5) console.log(`    ... and ${succeeded - 5} more`);
    }
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
