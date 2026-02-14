#!/usr/bin/env node
/**
 * discover-layers.js
 *
 * Queries every ArcGIS REST service URL in data/catalog.json.
 * If a dataset entry points at a root service (no /layerId suffix)
 * that contains multiple sublayers, it expands the entry into one
 * dataset per sublayer — each with its own id, title, geometry type,
 * and public_web_service URL.
 *
 * Single-layer root services are normalized to include the /0 suffix.
 * Entries that already point at a specific sublayer are left as-is.
 *
 * Usage:
 *   node scripts/discover-layers.js            # dry-run (shows diff)
 *   node scripts/discover-layers.js --write    # writes catalog.json
 */

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────────

const CATALOG_PATH = path.resolve(__dirname, '..', 'data', 'catalog.json');
const TIMEOUT_MS = 12000;       // per-request timeout
const CONCURRENCY = 4;          // parallel service queries
const RETRY_COUNT = 2;          // retries on failure

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

/** Pause for ms milliseconds */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch JSON from url with a timeout. Returns parsed JSON or null on error. */
async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'GIS-Catalog-Layer-Discovery/1.0' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with retries */
async function fetchJsonRetry(url, retries = RETRY_COUNT) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fetchJson(url);
    if (result !== null) return result;
    if (attempt < retries) {
      console.log(`  ↻ Retry ${attempt + 1} for ${url}`);
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Strip trailing slashes and return the base URL.
 */
function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Checks whether a URL already targets a specific sublayer index.
 * e.g. .../MapServer/0  or .../FeatureServer/3
 * Returns { isRoot: boolean, baseServiceUrl: string, layerId: number|null }
 */
function parseServiceUrl(url) {
  const u = normalizeUrl(url);
  // Match  .../(MapServer|FeatureServer|ImageServer)/digits  at end
  const m = u.match(/(.*\/(?:MapServer|FeatureServer|ImageServer))\/(\d+)$/i);
  if (m) {
    return { isRoot: false, baseServiceUrl: m[1], layerId: Number(m[2]) };
  }
  // Root service (no layer index)
  if (/\/(MapServer|FeatureServer|ImageServer)\s*$/i.test(u)) {
    return { isRoot: true, baseServiceUrl: u, layerId: null };
  }
  // Not recognized as an ArcGIS REST service
  return { isRoot: false, baseServiceUrl: u, layerId: null };
}

/**
 * Map Esri geometry types to the catalog's simpler names.
 */
function mapGeometryType(esriGeomType) {
  const g = String(esriGeomType || '').toUpperCase();
  if (g.includes('POLYGON')) return 'POLYGON';
  if (g.includes('POLYLINE') || g.includes('LINE')) return 'POLYLINE';
  if (g.includes('POINT')) return 'POINT';
  if (g.includes('MULTIPATCH')) return 'MULTIPATCH';
  if (g.includes('TABLE') || g === '') return 'TABLE';
  return g || 'UNKNOWN';
}

/**
 * Create a URL-safe, lowercase id slug from a string.
 */
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ────────────────────────────────────────────────────────────────
// CORE LOGIC
// ────────────────────────────────────────────────────────────────

/**
 * Query the REST endpoint for a root service and return its layer list.
 */
async function discoverLayers(serviceUrl) {
  const base = normalizeUrl(serviceUrl);
  const url = base.includes('?') ? `${base}&f=pjson` : `${base}?f=pjson`;
  const json = await fetchJsonRetry(url);
  if (!json) return null;

  // Collect layers and tables
  const layers = [
    ...(json.layers || []),
    ...(json.tables || []),
  ];

  return {
    serviceName: json.mapName || json.name || json.serviceDescription || '',
    serviceDescription: json.serviceDescription || json.description || '',
    spatialReference: json.spatialReference,
    layers,
    raw: json,
  };
}

/**
 * Fetch individual layer metadata (geometry type, name, description, fields).
 */
async function fetchLayerInfo(serviceUrl, layerId) {
  const base = normalizeUrl(serviceUrl);
  const url = `${base}/${layerId}?f=pjson`;
  return fetchJsonRetry(url);
}

/**
 * Process a single dataset entry:
 * - If it already points to a specific sublayer, return it unchanged.
 * - If it points to a root service, query for sublayers and expand.
 */
async function processDataset(ds) {
  const url = ds.public_web_service;
  if (!url) return [ds]; // no URL, keep as-is

  const parsed = parseServiceUrl(url);

  // Already points to a specific sublayer — keep it
  if (!parsed.isRoot) return [ds];

  console.log(`🔍 Discovering layers for: ${ds.id}`);
  console.log(`   ${url}`);

  const info = await discoverLayers(parsed.baseServiceUrl);
  if (!info || !info.layers || info.layers.length === 0) {
    console.log(`   ⚠ Could not discover layers (unreachable or empty). Keeping original entry.`);
    return [ds];
  }

  console.log(`   Found ${info.layers.length} layer(s)`);

  // If there's exactly 1 layer, just pin the URL to /0 and keep the original entry
  if (info.layers.length === 1) {
    const layer = info.layers[0];
    const layerId = layer.id !== undefined ? layer.id : 0;
    const updatedDs = { ...ds };
    updatedDs.public_web_service = `${parsed.baseServiceUrl}/${layerId}`;

    // Fetch layer details for geometry type if missing or "multiple"
    const layerInfo = await fetchLayerInfo(parsed.baseServiceUrl, layerId);
    if (layerInfo) {
      if (!updatedDs.geometry_type || updatedDs.geometry_type === 'multiple') {
        updatedDs.geometry_type = mapGeometryType(layerInfo.geometryType);
      }
    }

    console.log(`   Single layer → pinned to /${layerId}`);
    return [updatedDs];
  }

  // Multiple layers → expand into separate entries
  const expanded = [];

  for (const layer of info.layers) {
    const layerId = layer.id !== undefined ? layer.id : 0;
    const layerName = layer.name || `Layer ${layerId}`;

    // Fetch per-layer metadata
    const layerInfo = await fetchLayerInfo(parsed.baseServiceUrl, layerId);
    const geom = layerInfo
      ? mapGeometryType(layerInfo.geometryType)
      : mapGeometryType(layer.geometryType || '');

    // Skip "group layers" (they have subLayerIds but no geometry)
    if (layer.subLayerIds && Array.isArray(layer.subLayerIds) && layer.subLayerIds.length > 0) {
      console.log(`   ↳ Skipping group layer: ${layerName} (id ${layerId})`);
      continue;
    }

    // Build the expanded dataset entry
    const childId = `${ds.id}_${slugify(layerName) || `layer_${layerId}`}`;
    const childTitle = `${ds.title} – ${layerName}`;
    const childDescription = layerInfo?.description
      ? layerInfo.description
      : `${ds.description || ''} (sublayer: ${layerName})`.trim();

    const childDs = {
      ...ds,
      id: childId,
      title: childTitle,
      description: childDescription,
      geometry_type: geom,
      public_web_service: `${parsed.baseServiceUrl}/${layerId}`,
      // Track the parent so we can re-discover later
      _parent_service: parsed.baseServiceUrl,
      _parent_dataset_id: ds.id,
      _layer_id: layerId,
      _layer_name: layerName,
    };

    // If the original had "multiple" geometry_type, the child gets the real one
    // Remove fields that don't apply to individual sublayers
    delete childDs.geometry_type_note;

    expanded.push(childDs);
    console.log(`   ↳ ${childId} (/${layerId} — ${geom})`);
  }

  if (expanded.length === 0) {
    console.log(`   ⚠ All layers were group layers. Keeping original entry.`);
    return [ds];
  }

  return expanded;
}

// ────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────

async function main() {
  const writeMode = process.argv.includes('--write');

  console.log('═══════════════════════════════════════════════════');
  console.log('  GIS Catalog — Layer Discovery Script');
  console.log(`  Mode: ${writeMode ? 'WRITE (will update catalog.json)' : 'DRY-RUN (preview only)'}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // Load catalog
  const rawJson = fs.readFileSync(CATALOG_PATH, 'utf-8');
  const catalog = JSON.parse(rawJson);
  const datasets = catalog.datasets || [];

  console.log(`Loaded ${datasets.length} dataset(s) from catalog.json\n`);

  // Identify which entries need discovery (root services)
  const toProcess = [];
  const passthrough = [];

  for (const ds of datasets) {
    const parsed = parseServiceUrl(ds.public_web_service || '');
    if (parsed.isRoot) {
      toProcess.push(ds);
    } else {
      passthrough.push(ds);
    }
  }

  console.log(`${passthrough.length} dataset(s) already point to specific sublayers (unchanged)`);
  console.log(`${toProcess.length} dataset(s) point to root services (will discover sublayers)\n`);

  if (toProcess.length === 0) {
    console.log('Nothing to discover. Catalog is already fully expanded.');
    return;
  }

  // Process in batches with limited concurrency
  const results = [];
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processDataset));
    for (const expanded of batchResults) {
      results.push(...expanded);
    }
    // Small delay between batches to be polite to servers
    if (i + CONCURRENCY < toProcess.length) {
      await sleep(800);
    }
  }

  // Merge: passthrough entries + expanded entries, preserving order
  // We preserve the original order by keeping passthrough entries in place
  // and inserting expanded entries where the root entry was.
  const rootIds = new Set(toProcess.map((d) => d.id));
  const expandedByRootId = {};
  // Group results by their parent id
  for (const ds of results) {
    const parentId = ds._parent_dataset_id || ds.id;
    if (!expandedByRootId[parentId]) expandedByRootId[parentId] = [];
    expandedByRootId[parentId].push(ds);
  }

  const finalDatasets = [];
  for (const ds of datasets) {
    if (rootIds.has(ds.id) && expandedByRootId[ds.id]) {
      finalDatasets.push(...expandedByRootId[ds.id]);
    } else {
      finalDatasets.push(ds);
    }
  }

  // Deduplicate by id (in case script is run multiple times)
  const seenIds = new Set();
  const dedupedDatasets = [];
  for (const ds of finalDatasets) {
    if (seenIds.has(ds.id)) {
      console.log(`⚠ Duplicate id "${ds.id}" — keeping first occurrence`);
      continue;
    }
    seenIds.add(ds.id);
    dedupedDatasets.push(ds);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Before:  ${datasets.length} dataset(s)`);
  console.log(`  After:   ${dedupedDatasets.length} dataset(s)`);
  console.log(`  Added:   ${dedupedDatasets.length - datasets.length + toProcess.length} sublayer entries`);
  console.log(`  Removed: ${toProcess.length} root-level entries (replaced by sublayers)`);
  console.log('');

  // Show new entries
  const originalIds = new Set(datasets.map((d) => d.id));
  const newEntries = dedupedDatasets.filter((d) => !originalIds.has(d.id));
  if (newEntries.length) {
    console.log('  New entries:');
    for (const e of newEntries) {
      console.log(`    + ${e.id}  →  ${e.public_web_service}`);
    }
    console.log('');
  }

  if (writeMode) {
    catalog.datasets = dedupedDatasets;
    const output = JSON.stringify(catalog, null, 2) + '\n';
    fs.writeFileSync(CATALOG_PATH, output, 'utf-8');
    console.log(`✅ Wrote updated catalog.json (${dedupedDatasets.length} datasets)`);
  } else {
    console.log('ℹ  Dry run complete. Use --write to save changes:');
    console.log('   node scripts/discover-layers.js --write');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
