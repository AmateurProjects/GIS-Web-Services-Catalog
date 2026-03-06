// maturity-score.js — Simplified data maturity scoring engine.
// Pure synchronous scoring functions — no DOM, no fetch.
// Each check returns { label, ok, pts, maxPts, ... }.

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

// ── 1. Catalog Basics (0–15) ──
// Dataset Name, Description, Agency Owner filled out (5 each).

export function scoreCatalogBasics(dataset) {
  const checks = [
    { key: 'title',        label: 'Dataset Name',    present: !!dataset.title },
    { key: 'description',  label: 'Description',     present: !!dataset.description },
    { key: 'agency_owner', label: 'Agency Owner',    present: !!dataset.agency_owner },
  ];

  let score = 0;
  const details = checks.map(c => {
    const pts = c.present ? 5 : 0;
    score += pts;
    return { label: c.label, ok: c.present, pts, maxPts: 5, key: c.key };
  });

  return { score, max: 15, details };
}

// ── 2. Data Steward (0–10) ──
// Contact Email filled out.

export function scoreDataSteward(dataset) {
  const has = !!dataset.contact_email;
  return {
    score: has ? 10 : 0,
    max: 10,
    details: [{ label: 'Data steward (Contact Email)', ok: has, pts: has ? 10 : 0, maxPts: 10 }],
  };
}

// ── 3. Web Service URL (0–10) ──
// Public Web Service if Access Level is Public, and/or Internal Web Service filled out.

export function scoreWebService(dataset) {
  const accessLevel = (dataset.access_level || '').toLowerCase();
  const hasPublic = !!dataset.public_web_service;
  const hasInternal = !!dataset.internal_web_service;

  const details = [];
  let score = 0;

  if (accessLevel === 'public' || !accessLevel) {
    // Public datasets should have a public URL
    const ok = hasPublic;
    const pts = ok ? 10 : 0;
    score += pts;
    details.push({ label: 'Public Web Service URL', ok, pts, maxPts: 10 });
  } else {
    // Internal/restricted — internal URL sufficient, public is bonus
    if (hasInternal || hasPublic) {
      score = 10;
      details.push({ label: hasInternal ? 'Internal Web Service URL' : 'Public Web Service URL', ok: true, pts: 10, maxPts: 10 });
    } else {
      details.push({ label: 'Web Service URL (Public or Internal)', ok: false, pts: 0, maxPts: 10 });
    }
  }

  return { score, max: 10, details };
}

// ── 4. Data Standard (0–5) ──

export function scoreDataStandard(dataset) {
  const has = !!dataset.data_standard;
  return {
    score: has ? 5 : 0,
    max: 5,
    details: [{ label: 'Data Standard', ok: has, pts: has ? 5 : 0, maxPts: 5 }],
  };
}

// ── 5. Development Stage (0–10) ──
// Production = full points. Anything else = partial.

export function scoreDevelopmentStage(dataset) {
  const stage = (dataset.development_stage || '').toLowerCase();
  let pts;
  let label;
  if (stage === 'production') {
    pts = 10;
    label = 'Production';
  } else if (stage === 'qa') {
    pts = 7;
    label = 'QA';
  } else if (stage === 'in_development') {
    pts = 4;
    label = 'In Development';
  } else if (stage === 'planned') {
    pts = 2;
    label = 'Planned';
  } else if (stage === 'deprecated') {
    pts = 1;
    label = 'Deprecated';
  } else {
    pts = 0;
    label = 'Not set';
  }

  return {
    score: pts,
    max: 10,
    details: [{ label: `Development Stage: ${label}`, ok: pts === 10, pts, maxPts: 10 }],
  };
}

// ── 6. Blockers & Improvements (penalty, 0 to -10) ──
// Having open blockers or improvements needed lowers the score.

export function scoreBlockersImprovements(dataset) {
  const blockers = Array.isArray(dataset.blockers) ? dataset.blockers.filter(b => !!b) : [];
  const improvements = Array.isArray(dataset.improvements) ? dataset.improvements.filter(i => !!i) : [];
  const total = blockers.length + improvements.length;

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
  if (total === 0) {
    details.push({ label: 'No blockers or improvements needed', ok: true, pts: 0, maxPts: 0 });
  }

  return {
    score: -penalty,
    max: 0,
    details,
  };
}

// ── 7. Service Metadata (0–15) ──
// Description, Copyright, Subject filled out in the live service JSON.

export function scoreServiceMetadata({ serviceJson, layerJson }) {
  if (!serviceJson) {
    return {
      score: 0,
      max: 15,
      pending: true,
      details: [{ label: 'Service data not yet loaded', ok: false, pts: 0, maxPts: 15 }],
    };
  }

  const details = [];
  let score = 0;

  // Description (5 pts)
  const hasDesc = !!(serviceJson.serviceDescription || serviceJson.description || layerJson?.description);
  details.push({ label: 'Service Description', ok: hasDesc, pts: hasDesc ? 5 : 0, maxPts: 5 });
  score += hasDesc ? 5 : 0;

  // Copyright (5 pts)
  const hasCopy = !!serviceJson.copyrightText;
  details.push({ label: 'Copyright Text', ok: hasCopy, pts: hasCopy ? 5 : 0, maxPts: 5 });
  score += hasCopy ? 5 : 0;

  // Subject/Category/Tags (5 pts) — documentInfo.Subject or documentInfo.Keywords or tags array
  const docInfo = serviceJson.documentInfo || {};
  const hasSubject = !!(docInfo.Subject || docInfo.Keywords || docInfo.Category ||
    (Array.isArray(serviceJson.tags) && serviceJson.tags.length));
  details.push({ label: 'Subject / Keywords', ok: hasSubject, pts: hasSubject ? 5 : 0, maxPts: 5 });
  score += hasSubject ? 5 : 0;

  return { score, max: 15, details };
}

// ── 8. Service Capabilities (0–15) ──
// Does the service have appropriate capabilities for its type?

export function scoreServiceCapabilities({ serviceJson, layerJson }) {
  if (!serviceJson) {
    return {
      score: 0,
      max: 15,
      pending: true,
      details: [{ label: 'Service data not yet loaded', ok: false, pts: 0, maxPts: 15 }],
    };
  }

  const caps = (serviceJson.capabilities || '').toUpperCase();
  const details = [];
  let score = 0;

  // Query capability (5 pts)
  const hasQuery = caps.includes('QUERY');
  details.push({ label: 'Query capability', ok: hasQuery, pts: hasQuery ? 5 : 0, maxPts: 5 });
  score += hasQuery ? 5 : 0;

  // Statistics support (5 pts)
  const supportsStats = layerJson?.supportsStatistics ?? serviceJson.supportsStatistics ?? false;
  details.push({ label: 'Statistics support', ok: !!supportsStats, pts: supportsStats ? 5 : 0, maxPts: 5 });
  score += supportsStats ? 5 : 0;

  // Spatial reference defined (5 pts)
  const sr = serviceJson.spatialReference || layerJson?.spatialReference || {};
  const hasSR = !!(sr.wkid || sr.latestWkid);
  details.push({ label: 'Spatial reference defined', ok: hasSR, pts: hasSR ? 5 : 0, maxPts: 5 });
  score += hasSR ? 5 : 0;

  return { score, max: 15, details };
}

// ── 9. Attribute Null Health (0–20, with penalties) ──
// High null rates or mostly-null columns lower maturity.

export function scoreAttributeNullHealth({ fields, fieldStats }) {
  if (fields === null || fields === undefined) {
    return {
      score: 0,
      max: 20,
      pending: true,
      details: [{ label: 'Attribute data not yet loaded', ok: false, pts: 0, maxPts: 20 }],
    };
  }

  if (!fields.length) {
    return {
      score: 0,
      max: 20,
      details: [{ label: 'Service exposes no fields', ok: false, pts: 0, maxPts: 20 }],
    };
  }

  const details = [];
  let score = 0;

  // Filter out system fields
  const nonSystem = fields.filter(f => {
    const t = (f.type || '').toUpperCase();
    return !t.includes('OID') && !t.includes('GLOBALID') && !t.includes('GEOMETRY');
  });

  if (fieldStats && fieldStats.length) {
    const nullPcts = fieldStats
      .filter(s => typeof s.nullPct === 'number' && !isNaN(s.nullPct))
      .map(s => s.nullPct);

    if (nullPcts.length) {
      const avgNull = nullPcts.reduce((a, b) => a + b, 0) / nullPcts.length;

      // Base score from average null rate (0–15)
      let basePts;
      if (avgNull < 5) basePts = 15;
      else if (avgNull < 15) basePts = 12;
      else if (avgNull < 30) basePts = 8;
      else if (avgNull < 50) basePts = 4;
      else basePts = 0;
      score += basePts;
      details.push({ label: `Average null rate: ${avgNull.toFixed(1)}%`, ok: basePts >= 12, pts: basePts, maxPts: 15 });

      // Bonus: no columns > 80% null (5 pts)
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
    details.push({ label: 'Null statistics', ok: false, pts: 0, maxPts: 20, pending: true });
  }

  return { score: Math.max(0, Math.min(20, score)), max: 20, details };
}

// ── Composite score ──

export function computeFullScore({ basics, steward, webService, dataStandard, stage, issues, serviceMetadata, serviceCapabilities, nullHealth }) {
  const components = { basics, steward, webService, dataStandard, stage, issues, serviceMetadata, serviceCapabilities, nullHealth };
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

  // Max possible is 100 (15+10+10+5+10+0+15+15+20). Penalties can push below 0.
  const clamped = Math.max(0, Math.min(100, total));
  const tier = tierFromScore(clamped);

  return { total: clamped, tier, hasPending, components };
}
