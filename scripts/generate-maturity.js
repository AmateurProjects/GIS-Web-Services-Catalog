#!/usr/bin/env node
/**
 * generate-maturity.js — Pre-computes data maturity scores for all datasets.
 *
 * Mirrors the scoring logic in js/maturity-score.js but runs server-side,
 * reading catalog.json + data/service-info/*.json to compute all 9 sub-scores.
 *
 * Output: data/maturity.json
 *
 * Usage:
 *   node scripts/generate-maturity.js          # dry-run (prints stats only)
 *   node scripts/generate-maturity.js --write   # writes data/maturity.json
 */

'use strict';

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const WRITE = process.argv.includes('--write');
const DATA_DIR = join(process.cwd(), 'data');
const CATALOG_PATH = join(DATA_DIR, 'catalog.json');
const SERVICE_INFO_DIR = join(DATA_DIR, 'service-info');
const OUTPUT_PATH = join(DATA_DIR, 'maturity.json');

// ── Load catalog ──
let catalog;
try {
  catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
} catch (err) {
  console.error('✗ Could not load catalog.json:', err.message);
  process.exit(1);
}

const datasets = catalog.datasets || [];

// ── Scoring functions (mirrors js/maturity-score.js) ──

function tierFromScore(score) {
  if (score >= 80) return 'gold';
  if (score >= 60) return 'silver';
  return 'bronze';
}

function scoreCatalogBasics(dataset) {
  const checks = [
    { key: 'title', label: 'Dataset Name', present: !!dataset.title },
    { key: 'description', label: 'Description', present: !!dataset.description },
    { key: 'agency_owner', label: 'Agency Owner', present: !!dataset.agency_owner },
  ];
  let score = 0;
  const details = checks.map(c => {
    const pts = c.present ? 5 : 0;
    score += pts;
    return { label: c.label, ok: c.present, pts, maxPts: 5, key: c.key };
  });
  return { score, max: 15, details };
}

function scoreDataSteward(dataset) {
  const has = !!dataset.contact_email;
  return { score: has ? 10 : 0, max: 10, details: [{ label: 'Data steward (Contact Email)', ok: has, pts: has ? 10 : 0, maxPts: 10 }] };
}

function scoreWebService(dataset) {
  const accessLevel = (dataset.access_level || '').toLowerCase();
  const hasPublic = !!dataset.public_web_service;
  const hasInternal = !!dataset.internal_web_service;
  const details = [];
  let score = 0;
  if (accessLevel === 'public' || !accessLevel) {
    const ok = hasPublic;
    const pts = ok ? 10 : 0;
    score += pts;
    details.push({ label: 'Public Web Service URL', ok, pts, maxPts: 10 });
  } else {
    if (hasInternal || hasPublic) {
      score = 10;
      details.push({ label: hasInternal ? 'Internal Web Service URL' : 'Public Web Service URL', ok: true, pts: 10, maxPts: 10 });
    } else {
      details.push({ label: 'Web Service URL (Public or Internal)', ok: false, pts: 0, maxPts: 10 });
    }
  }
  return { score, max: 10, details };
}

function scoreDataStandard(dataset) {
  const has = !!dataset.data_standard;
  return { score: has ? 5 : 0, max: 5, details: [{ label: 'Data Standard', ok: has, pts: has ? 5 : 0, maxPts: 5 }] };
}

function scoreDevelopmentStage(dataset) {
  const stage = (dataset.development_stage || '').toLowerCase();
  let pts, label;
  if (stage === 'production') { pts = 10; label = 'Production'; }
  else if (stage === 'qa') { pts = 7; label = 'QA'; }
  else if (stage === 'in_development') { pts = 4; label = 'In Development'; }
  else if (stage === 'planned') { pts = 2; label = 'Planned'; }
  else if (stage === 'deprecated') { pts = 1; label = 'Deprecated'; }
  else { pts = 0; label = 'Not set'; }
  return { score: pts, max: 10, details: [{ label: `Development Stage: ${label}`, ok: pts === 10, pts, maxPts: 10 }] };
}

function scoreBlockersImprovements(dataset) {
  const blockers = Array.isArray(dataset.blockers) ? dataset.blockers.filter(b => !!b) : [];
  const improvements = Array.isArray(dataset.improvements) ? dataset.improvements.filter(i => !!i) : [];
  const details = [];
  let penalty = 0;
  if (blockers.length > 0) {
    const p = Math.min(blockers.length * 3, 6);
    penalty += p;
    details.push({ label: `${blockers.length} blocker(s)`, ok: false, pts: -p, maxPts: 0, isPenalty: true });
  }
  if (improvements.length > 0) {
    const p = Math.min(improvements.length * 2, 4);
    penalty += p;
    details.push({ label: `${improvements.length} improvement(s) needed`, ok: false, pts: -p, maxPts: 0, isPenalty: true });
  }
  if (blockers.length === 0 && improvements.length === 0) {
    details.push({ label: 'No blockers or improvements needed', ok: true, pts: 0, maxPts: 0 });
  }
  return { score: -penalty, max: 0, details };
}

function scoreServiceMetadata({ serviceJson, layerJson }) {
  if (!serviceJson) {
    return { score: 0, max: 15, details: [{ label: 'No service-info cached', ok: false, pts: 0, maxPts: 15 }] };
  }
  const details = [];
  let score = 0;
  const hasDesc = !!(serviceJson.serviceDescription || serviceJson.description || layerJson?.description);
  details.push({ label: 'Service Description', ok: hasDesc, pts: hasDesc ? 5 : 0, maxPts: 5 });
  score += hasDesc ? 5 : 0;
  const hasCopy = !!serviceJson.copyrightText;
  details.push({ label: 'Copyright Text', ok: hasCopy, pts: hasCopy ? 5 : 0, maxPts: 5 });
  score += hasCopy ? 5 : 0;
  const docInfo = serviceJson.documentInfo || {};
  const hasSubject = !!(docInfo.Subject || docInfo.Keywords || docInfo.Category || (Array.isArray(serviceJson.tags) && serviceJson.tags.length));
  details.push({ label: 'Subject / Keywords', ok: hasSubject, pts: hasSubject ? 5 : 0, maxPts: 5 });
  score += hasSubject ? 5 : 0;
  return { score, max: 15, details };
}

function scoreServiceCapabilities({ serviceJson, layerJson }) {
  if (!serviceJson) {
    return { score: 0, max: 15, details: [{ label: 'No service-info cached', ok: false, pts: 0, maxPts: 15 }] };
  }
  const caps = (serviceJson.capabilities || '').toUpperCase();
  const details = [];
  let score = 0;
  const hasQuery = caps.includes('QUERY');
  details.push({ label: 'Query capability', ok: hasQuery, pts: hasQuery ? 5 : 0, maxPts: 5 });
  score += hasQuery ? 5 : 0;
  const supportsStats = layerJson?.supportsStatistics ?? serviceJson.supportsStatistics ?? false;
  details.push({ label: 'Statistics support', ok: !!supportsStats, pts: supportsStats ? 5 : 0, maxPts: 5 });
  score += supportsStats ? 5 : 0;
  const sr = serviceJson.spatialReference || layerJson?.spatialReference || {};
  const hasSR = !!(sr.wkid || sr.latestWkid);
  details.push({ label: 'Spatial reference defined', ok: hasSR, pts: hasSR ? 5 : 0, maxPts: 5 });
  score += hasSR ? 5 : 0;
  return { score, max: 15, details };
}

function scoreAttributeNullHealth({ fields, fieldStats }) {
  if (!fields || !fields.length) {
    return { score: 0, max: 20, details: [{ label: 'No field data available', ok: false, pts: 0, maxPts: 20 }] };
  }
  const details = [];
  let score = 0;
  if (fieldStats && fieldStats.length) {
    const nullPcts = fieldStats.filter(s => typeof s.nullPct === 'number' && !isNaN(s.nullPct)).map(s => s.nullPct);
    if (nullPcts.length) {
      const avgNull = nullPcts.reduce((a, b) => a + b, 0) / nullPcts.length;
      let basePts;
      if (avgNull < 5) basePts = 15;
      else if (avgNull < 15) basePts = 12;
      else if (avgNull < 30) basePts = 8;
      else if (avgNull < 50) basePts = 4;
      else basePts = 0;
      score += basePts;
      details.push({ label: `Average null rate: ${avgNull.toFixed(1)}%`, ok: basePts >= 12, pts: basePts, maxPts: 15 });
      const highNullCount = nullPcts.filter(p => p > 80).length;
      if (highNullCount === 0) {
        score += 5;
        details.push({ label: 'No columns over 80% null', ok: true, pts: 5, maxPts: 5 });
      } else {
        details.push({ label: `${highNullCount} column(s) over 80% null`, ok: false, pts: 0, maxPts: 5, isPenalty: true });
      }
    } else {
      details.push({ label: 'No null statistics available', ok: false, pts: 0, maxPts: 20 });
    }
  } else {
    details.push({ label: 'No null statistics available', ok: false, pts: 0, maxPts: 20 });
  }
  return { score: Math.max(0, Math.min(20, score)), max: 20, details };
}

function computeFullScore({ basics, steward, webService, dataStandard, stage, issues, serviceMetadata, serviceCapabilities, nullHealth }) {
  const components = { basics, steward, webService, dataStandard, stage, issues, serviceMetadata, serviceCapabilities, nullHealth };
  let total = 0;
  let max = 0;
  Object.values(components).forEach(c => {
    if (c) { total += c.score; max += c.max; }
  });
  const clamped = Math.max(0, Math.min(100, total));
  const tier = tierFromScore(clamped);
  return { total: clamped, tier, components };
}

// ── Main ──

function loadServiceInfo(datasetId) {
  const filePath = join(SERVICE_INFO_DIR, `${datasetId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (_) { return null; }
}

const results = [];
const tierCounts = { gold: 0, silver: 0, bronze: 0 };

datasets.forEach(ds => {
  const info = loadServiceInfo(ds.id);

  const basics = scoreCatalogBasics(ds);
  const steward = scoreDataSteward(ds);
  const webService = scoreWebService(ds);
  const dataStandard = scoreDataStandard(ds);
  const stage = scoreDevelopmentStage(ds);
  const issues = scoreBlockersImprovements(ds);

  // Service-dependent scores from cached service-info
  const serviceJson = info?.serviceMetadata || info?.serviceJson || null;
  const layerJson = info?.layerJson || null;
  const fields = info?.fields || null;
  const fieldStats = info?.fieldStats || null;

  const serviceMetadata = scoreServiceMetadata({ serviceJson, layerJson });
  const serviceCapabilities = scoreServiceCapabilities({ serviceJson, layerJson });
  const nullHealth = scoreAttributeNullHealth({ fields, fieldStats });

  const full = computeFullScore({ basics, steward, webService, dataStandard, stage, issues, serviceMetadata, serviceCapabilities, nullHealth });

  tierCounts[full.tier]++;

  results.push({
    datasetId: ds.id,
    score: full.total,
    tier: full.tier,
    components: {
      basics: basics.score,
      steward: steward.score,
      webService: webService.score,
      dataStandard: dataStandard.score,
      stage: stage.score,
      issues: issues.score,
      serviceMetadata: serviceMetadata.score,
      serviceCapabilities: serviceCapabilities.score,
      nullHealth: nullHealth.score,
    },
  });
});

const output = {
  generated: new Date().toISOString(),
  totalDatasets: results.length,
  tiers: tierCounts,
  datasets: results,
};

console.log(`\nMaturity scores computed for ${results.length} datasets:`);
console.log(`  🥇 Gold:   ${tierCounts.gold}`);
console.log(`  🥈 Silver: ${tierCounts.silver}`);
console.log(`  🥉 Bronze: ${tierCounts.bronze}`);

if (WRITE) {
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${OUTPUT_PATH}`);
} else {
  console.log('\nDry-run — use --write to save data/maturity.json');
}
