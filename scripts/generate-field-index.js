#!/usr/bin/env node
// generate-field-index.js — Aggregates field data from all service-info files
// into a single data/field-index.json for fast frontend loading.
//
// Usage:
//   node scripts/generate-field-index.js          # dry-run (prints stats only)
//   node scripts/generate-field-index.js --write   # writes data/field-index.json
//
// This script reads every data/service-info/<id>.json file and builds a compact
// cross-dataset field dictionary. The frontend (field-explorer.js) loads this
// file for instant rendering instead of fetching ~100 individual service-info files.

const { readFileSync, writeFileSync, readdirSync, existsSync } = require('fs');
const { join, basename } = require('path');

const WRITE = process.argv.includes('--write');
const DATA_DIR = join(process.cwd(), 'data');
const SERVICE_INFO_DIR = join(DATA_DIR, 'service-info');
const CATALOG_PATH = join(DATA_DIR, 'catalog.json');
const OUTPUT_PATH = join(DATA_DIR, 'field-index.json');

// ── Load catalog for dataset titles ──
let dsById = {};
try {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  (catalog.datasets || []).forEach(d => { dsById[d.id] = d; });
} catch (err) {
  console.error('⚠ Could not load catalog.json — dataset titles will use IDs:', err.message);
}

// ── Scan service-info files ──
if (!existsSync(SERVICE_INFO_DIR)) {
  console.error('❌ data/service-info/ directory not found. Run generate-service-info.js first.');
  process.exit(1);
}

const infoFiles = readdirSync(SERVICE_INFO_DIR).filter(f => f.endsWith('.json'));
console.log(`Found ${infoFiles.length} service-info files.`);

// ── Build field map ──
const fieldMap = {};
let filesProcessed = 0;

infoFiles.forEach(filename => {
  const datasetId = basename(filename, '.json');
  try {
    const raw = readFileSync(join(SERVICE_INFO_DIR, filename), 'utf-8');
    const info = JSON.parse(raw);

    const ds = dsById[datasetId];
    const dsTitle = ds ? (ds._layer_name || ds.title || ds.id) : datasetId;

    const fields = info.fields || [];
    const fStats = info.fieldStats || [];
    const statsMap = {};
    fStats.forEach(s => { statsMap[s.name] = s; });

    // Detect the server-echo bug: if >75% of non-identity fields have
    // distinctCount === recordCount, the server returned junk.
    const recordCount = info.metadata?.recordCount || 0;
    let suspectDistinct = false;
    if (recordCount > 50 && fStats.length >= 3) {
      let eligible = 0, matching = 0;
      for (const s of fStats) {
        if (s.skipped) continue;
        const ft = (s.type || '').toUpperCase();
        if (ft.includes('OID') || ft.includes('GLOBALID') || ft.includes('GEOMETRY')) continue;
        eligible++;
        if (s.distinctCount === recordCount) matching++;
      }
      suspectDistinct = eligible >= 3 && (matching / eligible) > 0.75;
    }

    fields.forEach(f => {
      const name = f.name;
      if (!fieldMap[name]) {
        fieldMap[name] = {
          name,
          _aliasCounts: {},
          _typeCounts: {},
          _nullPcts: [],
          _hasDomain: false,
          datasetCount: 0,
          datasets: [],
        };
      }

      const entry = fieldMap[name];
      entry.datasetCount++;

      const alias = f.alias || name;
      entry._aliasCounts[alias] = (entry._aliasCounts[alias] || 0) + 1;

      const type = f.type || 'unknown';
      entry._typeCounts[type] = (entry._typeCounts[type] || 0) + 1;

      const stats = statsMap[name];
      const nullPct = stats?.nullPct ?? null;
      const rawDc = stats?.distinctCount ?? null;
      // Suppress suspect distinct counts (server-echo bug) for this dataset
      const distinctCount = (suspectDistinct && rawDc === recordCount) ? null : rawDc;
      const hasDomain = !!(f.domain || stats?.hasDomain);
      // [Placeholder Detection]
      const emptyPct = stats?.emptyPct ?? null;
      const dominantValue = stats?.dominantValue ?? null;
      const dominantPct = stats?.dominantPct ?? null;
      // [/Placeholder Detection]

      if (hasDomain) entry._hasDomain = true;
      if (nullPct !== null && nullPct !== undefined) entry._nullPcts.push(nullPct);

      entry.datasets.push({
        datasetId,
        datasetTitle: dsTitle,
        type,
        alias,
        nullPct,
        distinctCount,
        hasDomain,
        // [Placeholder Detection]
        emptyPct,
        dominantValue,
        dominantPct,
        // [/Placeholder Detection]
      });
    });

    filesProcessed++;
  } catch (err) {
    console.warn(`⚠ Skipping ${filename}: ${err.message}`);
  }
});

// ── Finalize entries ──
const fields = Object.values(fieldMap).map(entry => {
  // Primary alias (most common)
  const aliasSorted = Object.entries(entry._aliasCounts).sort((a, b) => b[1] - a[1]);
  const primaryAlias = aliasSorted.length ? aliasSorted[0][0] : entry.name;
  const aliases = [...new Set(Object.keys(entry._aliasCounts))];

  // Primary type (most common)
  const typeSorted = Object.entries(entry._typeCounts).sort((a, b) => b[1] - a[1]);
  const primaryType = typeSorted.length ? typeSorted[0][0] : 'unknown';
  const types = [...new Set(Object.keys(entry._typeCounts))];

  // Average null percentage
  const avgNullPct = entry._nullPcts.length
    ? Math.round(entry._nullPcts.reduce((a, b) => a + b, 0) / entry._nullPcts.length * 10) / 10
    : null;

  // Sort datasets alphabetically
  entry.datasets.sort((a, b) => a.datasetTitle.localeCompare(b.datasetTitle));

  return {
    name: entry.name,
    primaryAlias,
    aliases,
    primaryType,
    types,
    datasetCount: entry.datasetCount,
    avgNullPct,
    hasDomain: entry._hasDomain,
    datasets: entry.datasets,
  };
});

// Sort: most-used first, then alphabetically
fields.sort((a, b) => b.datasetCount - a.datasetCount || a.name.localeCompare(b.name));

const output = {
  generated: new Date().toISOString(),
  totalDatasets: filesProcessed,
  totalFields: fields.length,
  fields,
};

// ── Stats ──
console.log(`\nProcessed ${filesProcessed} datasets.`);
console.log(`Found ${fields.length} unique fields.`);
console.log(`Fields appearing in 10+ datasets: ${fields.filter(f => f.datasetCount >= 10).length}`);
console.log(`Fields with type inconsistencies: ${fields.filter(f => f.types.length > 1).length}`);
console.log(`Fields with domains: ${fields.filter(f => f.hasDomain).length}`);

const jsonStr = JSON.stringify(output, null, 2);
const sizeKB = (Buffer.byteLength(jsonStr, 'utf-8') / 1024).toFixed(1);
console.log(`Output size: ${sizeKB} KB`);

if (WRITE) {
  writeFileSync(OUTPUT_PATH, jsonStr, 'utf-8');
  console.log(`\n✅ Wrote ${OUTPUT_PATH}`);
} else {
  console.log('\nDry run — pass --write to save. Top 20 most-used fields:');
  fields.slice(0, 20).forEach(f => {
    console.log(`  ${f.name.padEnd(30)} ${String(f.datasetCount).padStart(3)} datasets  ${f.primaryType}`);
  });
}
