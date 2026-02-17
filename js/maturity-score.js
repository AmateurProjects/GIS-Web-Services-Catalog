// maturity-score.js — Automated data maturity scoring engine.
// Pure synchronous scoring functions — no DOM, no fetch.
// Each sub-score returns { score, max, details[] }.

import { getAttributesForDataset } from './catalog.js';

// ── Tier thresholds ──

export function tierFromScore(score) {
  if (score >= 80) return 'gold';
  if (score >= 60) return 'silver';
  return 'bronze';
}

export const TIER_META = {
  gold:   { label: 'Gold',   icon: '🥇', css: 'tier-gold' },
  silver: { label: 'Silver', icon: '🥈', css: 'tier-silver' },
  bronze: { label: 'Bronze', icon: '🥉', css: 'tier-bronze' },
};

// ── Sub-score: Catalog Completeness (0–30) ──

export function scoreCatalogCompleteness(dataset) {
  const checks = [
    // Core metadata (11 items)
    { key: 'title',            label: 'Title',              present: !!dataset.title },
    { key: 'description',     label: 'Description',        present: !!dataset.description },
    { key: 'agency_owner',    label: 'Agency Owner',       present: !!dataset.agency_owner },
    { key: 'office_owner',    label: 'Office Owner',       present: !!dataset.office_owner },
    { key: 'contact_email',   label: 'Contact Email',      present: !!dataset.contact_email },
    { key: 'geometry_type',   label: 'Geometry Type',      present: !!dataset.geometry_type },
    { key: 'update_frequency', label: 'Update Frequency',  present: !!dataset.update_frequency },
    { key: 'access_level',    label: 'Access Level',       present: !!dataset.access_level },
    { key: 'topics',          label: 'Topics',             present: Array.isArray(dataset.topics) && dataset.topics.length > 0 },
    { key: 'public_web_service', label: 'Public Web Service', present: !!dataset.public_web_service },
    { key: 'data_standard',   label: 'Data Standard',      present: !!dataset.data_standard },
    // Bonus metadata (4 items)
    { key: 'development_stage', label: 'Development Stage', present: !!dataset.development_stage && dataset.development_stage !== 'unknown' },
    { key: 'notes',           label: 'Notes',              present: !!dataset.notes },
    { key: 'objname',         label: 'Database Object Name', present: !!dataset.objname },
    { key: 'projection',      label: 'Projection',         present: !!dataset.projection },
  ];

  const filled = checks.filter(c => c.present).length;
  const total = checks.length; // 15
  const score = Math.round((filled / total) * 30);

  return { score, max: 30, filled, total, details: checks };
}

// ── Sub-score: Service Health (0–25) ──

export function scoreServiceHealth({ serviceJson, layerJson }) {
  if (!serviceJson) {
    return {
      score: 0,
      max: 25,
      pending: true,
      details: [{ label: 'Service data not yet loaded', ok: false, pts: 0, maxPts: 25 }],
    };
  }

  const items = [];
  let score = 0;

  // Service responds (10 pts)
  items.push({ label: 'Service responds to REST query', ok: true, pts: 10, maxPts: 10 });
  score += 10;

  // Query capability (5 pts)
  const caps = (serviceJson.capabilities || '').toUpperCase();
  const hasQuery = caps.includes('QUERY');
  items.push({ label: 'Query capability enabled', ok: hasQuery, pts: hasQuery ? 5 : 0, maxPts: 5 });
  score += hasQuery ? 5 : 0;

  // Statistics support (3 pts)
  const supportsStats = layerJson?.supportsStatistics ?? serviceJson.supportsStatistics ?? false;
  items.push({ label: 'Statistics support', ok: !!supportsStats, pts: supportsStats ? 3 : 0, maxPts: 3 });
  score += supportsStats ? 3 : 0;

  // Advanced queries (2 pts)
  const advQ = layerJson?.advancedQueryCapabilities?.supportsAdvancedQueries ?? false;
  items.push({ label: 'Advanced query support', ok: !!advQ, pts: advQ ? 2 : 0, maxPts: 2 });
  score += advQ ? 2 : 0;

  // Spatial reference defined (2 pts)
  const sr = serviceJson.spatialReference || layerJson?.spatialReference || {};
  const hasWkid = !!(sr.wkid || sr.latestWkid);
  items.push({ label: 'Spatial reference defined', ok: hasWkid, pts: hasWkid ? 2 : 0, maxPts: 2 });
  score += hasWkid ? 2 : 0;

  // Service documentation (3 pts — 2 for description, 1 for copyright)
  const hasDesc = !!(serviceJson.serviceDescription || serviceJson.description);
  const hasCopy = !!serviceJson.copyrightText;
  const docPts = (hasDesc ? 2 : 0) + (hasCopy ? 1 : 0);
  items.push({ label: 'Service documentation (description/copyright)', ok: docPts > 0, pts: docPts, maxPts: 3 });
  score += docPts;

  return { score, max: 25, details: items };
}

// ── Sub-score: Attribute Table Quality (0–25) ──

export function scoreAttributeQuality({ fields, fieldStats, totalCount }) {
  // fields = null → data not loaded yet
  if (fields === null || fields === undefined) {
    return {
      score: 0,
      max: 25,
      pending: true,
      details: [{ label: 'Attribute data not yet loaded', ok: false, pts: 0, maxPts: 25 }],
    };
  }

  // fields = [] → service has no fields (or it's a non-query service)
  if (!fields.length) {
    return {
      score: 0,
      max: 25,
      details: [{ label: 'Service exposes no fields', ok: false, pts: 0, maxPts: 25 }],
    };
  }

  const items = [];
  let score = 0;

  // Filter out system/key fields for quality checks
  const nonSystem = fields.filter(f => {
    const t = (f.type || '').toUpperCase();
    return !t.includes('OID') && !t.includes('GLOBALID') && !t.includes('GEOMETRY');
  });

  // A) Fields exist (5 pts)
  items.push({ label: 'Fields present', ok: true, pts: 5, maxPts: 5 });
  score += 5;

  // B) Schema width (5 pts) — penalizes excessively wide tables
  const count = nonSystem.length;
  let widthPts;
  if (count <= 25) widthPts = 5;
  else if (count <= 40) widthPts = 4;
  else if (count <= 60) widthPts = 2;
  else widthPts = 0;
  const widthLabel = `Schema width (${count} non-system fields)`;
  items.push({ label: widthLabel, ok: widthPts >= 4, pts: widthPts, maxPts: 5 });
  score += widthPts;

  // C) Alias coverage (5 pts) — fields should have human-readable aliases
  const aliasCount = nonSystem.filter(f => f.alias && f.alias !== f.name).length;
  const aliasPct = count > 0 ? aliasCount / count : 0;
  const aliasPts = Math.round(aliasPct * 5);
  items.push({ label: `Field aliases (${Math.round(aliasPct * 100)}% aliased)`, ok: aliasPts >= 3, pts: aliasPts, maxPts: 5 });
  score += aliasPts;

  // D) Domain usage (3 pts) — coded value domains indicate well-governed data
  const domainCount = nonSystem.filter(f => f.domain && f.domain.type === 'codedValue').length;
  const domainPts = Math.min(domainCount, 3);
  items.push({ label: `Coded value domains (${domainCount} fields)`, ok: domainPts > 0, pts: domainPts, maxPts: 3 });
  score += domainPts;

  // E) Null health (7 pts) — requires field stats (async)
  if (fieldStats && fieldStats.length) {
    const nullPcts = fieldStats
      .filter(s => typeof s.nullPct === 'number' && !isNaN(s.nullPct))
      .map(s => s.nullPct);

    if (nullPcts.length) {
      const avgNull = nullPcts.reduce((a, b) => a + b, 0) / nullPcts.length;
      let nullPts;
      if (avgNull < 10) nullPts = 7;
      else if (avgNull < 25) nullPts = 5;
      else if (avgNull < 40) nullPts = 3;
      else if (avgNull < 60) nullPts = 1;
      else nullPts = 0;
      items.push({ label: `Avg null rate (${avgNull.toFixed(1)}%)`, ok: nullPts >= 5, pts: nullPts, maxPts: 7 });
      score += nullPts;

      // High-null penalty: -1 per field >80% null (max -3)
      const highNull = nullPcts.filter(p => p > 80).length;
      if (highNull > 0) {
        const penalty = Math.min(highNull, 3);
        items.push({ label: `${highNull} field(s) >80% null`, ok: false, pts: -penalty, maxPts: 0, isPenalty: true });
        score -= penalty;
      }
    }
  } else {
    items.push({ label: 'Null statistics', ok: false, pts: 0, maxPts: 7, pending: true });
  }

  return { score: Math.max(0, Math.min(25, score)), max: 25, details: items };
}

// ── Sub-score: Coverage (0–10) ──

export function scoreCoverage(dataset) {
  const cov = dataset._coverage;
  if (!cov || !cov.states) {
    return {
      score: 0,
      max: 10,
      details: [{ label: 'No pre-computed coverage data', ok: false, pts: 0, maxPts: 10 }],
    };
  }

  const statesWithData = cov.statesWithData || 0;
  let pts;
  if (statesWithData >= 5) pts = 10;
  else if (statesWithData >= 3) pts = 7;
  else if (statesWithData >= 1) pts = 4;
  else pts = 0;

  return {
    score: pts,
    max: 10,
    details: [{ label: `${statesWithData} state(s) with data`, ok: pts === 10, pts, maxPts: 10 }],
  };
}

// ── Sub-score: Documentation (0–10) ──

export function scoreDocumentation(dataset) {
  const attrs = getAttributesForDataset(dataset) || [];
  const items = [];
  let score = 0;

  // Attribute IDs linked (3 pts)
  const attrIds = dataset.attribute_ids || [];
  const hasAttrs = attrIds.length > 0;
  items.push({ label: 'Attribute IDs linked to dataset', ok: hasAttrs, pts: hasAttrs ? 3 : 0, maxPts: 3 });
  score += hasAttrs ? 3 : 0;

  if (hasAttrs && attrs.length) {
    // Definitions present (3 pts)
    const withDef = attrs.filter(a => !!a.definition).length;
    const defPts = Math.round((withDef / attrs.length) * 3);
    items.push({ label: `Attribute definitions (${withDef}/${attrs.length})`, ok: defPts >= 2, pts: defPts, maxPts: 3 });
    score += defPts;

    // Expected values (2 pts)
    const withExp = attrs.filter(a => a.expected_value !== undefined && a.expected_value !== '').length;
    const expPts = Math.round((withExp / attrs.length) * 2);
    items.push({ label: `Expected value examples (${withExp}/${attrs.length})`, ok: expPts > 0, pts: expPts, maxPts: 2 });
    score += expPts;

    // Enumerated values (2 pts)
    const enumAttrs = attrs.filter(a => a.type === 'enumerated');
    if (enumAttrs.length) {
      const withVals = enumAttrs.filter(a => Array.isArray(a.values) && a.values.length).length;
      const enumPts = Math.round((withVals / enumAttrs.length) * 2);
      items.push({ label: `Enum values documented (${withVals}/${enumAttrs.length})`, ok: enumPts > 0, pts: enumPts, maxPts: 2 });
      score += enumPts;
    } else {
      // No enumerated attrs — full marks (nothing to document)
      items.push({ label: 'No enumerated attributes to document', ok: true, pts: 2, maxPts: 2 });
      score += 2;
    }
  } else {
    items.push({ label: 'Attribute definitions', ok: false, pts: 0, maxPts: 3 });
    items.push({ label: 'Expected value examples', ok: false, pts: 0, maxPts: 2 });
    items.push({ label: 'Enumerated values', ok: false, pts: 0, maxPts: 2 });
  }

  return { score, max: 10, details: items };
}

// ── Composite score ──

/**
 * Compute the full maturity score from all sub-components.
 * Any component can be null/undefined (pending async data).
 */
export function computeFullScore({ catalog, service, attributes, coverage, docs }) {
  const components = { catalog, service, attributes, coverage, docs };
  let total = 0;
  let max = 0;
  let hasPending = false;

  Object.values(components).forEach(c => {
    if (c) {
      total += c.score;
      max += c.max;
      if (c.pending) hasPending = true;
    }
  });

  const pct = max > 0 ? Math.round((total / max) * 100) : 0;
  // Normalize to 0-100 scale
  const normalized = max === 100 ? total : pct;
  const tier = tierFromScore(normalized);

  return { total: normalized, tier, hasPending, components };
}
