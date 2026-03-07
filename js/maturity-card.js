// maturity-card.js — Renders and manages the auto-computed Data Maturity card.
// Initializes with instant sub-scores (catalog, coverage, docs),
// then updates live when service/field data arrives via CustomEvents.

import { escapeHtml } from './utils.js';
import {
  scoreCatalogBasics,
  scoreDataSteward,
  scoreWebService,
  scoreDataStandard,
  scoreDevelopmentStage,
  scoreBlockersImprovements,
  scoreServiceMetadata,
  scoreServiceCapabilities,
  scoreAttributeNullHealth,
  scoreFreshnessConfidence,
  computeFullScore,
  tierFromScore,
  TIER_META,
} from './maturity-score.js';

// ── Freshness index cache (loaded once for confidence lookup) ──
let _freshnessIndex = undefined;

async function loadFreshnessIndex() {
  if (_freshnessIndex !== undefined) return _freshnessIndex;
  try {
    const resp = await fetch('data/freshness.json');
    if (!resp.ok) { _freshnessIndex = null; return null; }
    _freshnessIndex = await resp.json();
    return _freshnessIndex;
  } catch {
    _freshnessIndex = null;
    return null;
  }
}

// ── Card HTML placeholder (inserted by detail.js) ──

export function maturityCardHTML() {
  return `
    <div class="card card-maturity" id="maturityScoreCard">
      <div class="card-header-row">
        <h3>\uD83D\uDCCA Data Maturity</h3>
        <span class="data-source-badge data-source-badge-auto">Auto</span>
      </div>
      <p class="text-muted" style="margin-bottom:0.75rem;font-size:0.85rem;">
        Automated quality assessment based on catalog metadata, service documentation, capabilities, and attribute health.
      </p>
      <div data-maturity-body>
        <p class="loading-message" style="font-size:0.85rem;">Analyzing\u2026</p>
      </div>
    </div>
  `;
}

// ── Initialize the maturity card and wire event listeners ──

/**
 * Call AFTER the detail panel innerHTML is set.
 * Computes instant sub-scores and renders them, then listens for
 * 'maturity:service-data' and 'maturity:field-stats' events to update live.
 *
 * @param {HTMLElement} hostEl — the dataset detail panel (els.datasetDetailEl)
 * @param {Object} dataset — the full dataset object
 * @param {boolean} hasService — whether dataset has a public_web_service URL
 */
export async function initMaturityCard(hostEl, dataset, hasService) {
  const card = hostEl.querySelector('#maturityScoreCard');
  if (!card) return;
  const body = card.querySelector('[data-maturity-body]');
  if (!body) return;

  // ── Always compute client-side for real-time accuracy ──

  // Load freshness index for confidence scoring
  const freshnessIdx = await loadFreshnessIndex();
  const freshnessResult = freshnessIdx?.datasets?.find(d => d.datasetId === dataset.id) || null;
  const freshnessConfidence = scoreFreshnessConfidence(freshnessResult);

  const basics = scoreCatalogBasics(dataset);
  const steward = scoreDataSteward(dataset);
  const webService = scoreWebService(dataset);
  const dataStandard = scoreDataStandard(dataset);
  const stage = scoreDevelopmentStage(dataset);
  const issues = scoreBlockersImprovements(dataset);

  // Service-dependent scores start as pending (or N/A if no service)
  let serviceMetadata = hasService
    ? { score: 0, max: 15, pending: true, details: [{ label: 'Analyzing service metadata\u2026', ok: false, pts: 0, maxPts: 15 }] }
    : { score: 0, max: 15, details: [{ label: 'No public web service configured', ok: false, pts: 0, maxPts: 15 }] };

  let serviceCapabilities = hasService
    ? { score: 0, max: 15, pending: true, details: [{ label: 'Analyzing service capabilities\u2026', ok: false, pts: 0, maxPts: 15 }] }
    : { score: 0, max: 15, details: [{ label: 'No service to analyze', ok: false, pts: 0, maxPts: 15 }] };

  let nullHealth = hasService
    ? { score: 0, max: 20, pending: true, details: [{ label: 'Analyzing attribute schema\u2026', ok: false, pts: 0, maxPts: 20 }] }
    : { score: 0, max: 20, details: [{ label: 'No service to analyze', ok: false, pts: 0, maxPts: 20 }] };

  // Stash fields for later stats update
  let _layerFields = null;

  render();

  // ── Listen for live service data ──
  if (hasService) {
    hostEl.addEventListener('maturity:service-data', (e) => {
      const { serviceJson, layerJson } = e.detail || {};
      serviceMetadata = scoreServiceMetadata({ serviceJson, layerJson });
      serviceCapabilities = scoreServiceCapabilities({ serviceJson, layerJson });
      _layerFields = layerJson?.fields || null;
      nullHealth = scoreAttributeNullHealth({ fields: _layerFields, fieldStats: null });
      render();
    });

    hostEl.addEventListener('maturity:field-stats', (e) => {
      const { fieldStats } = e.detail || {};
      nullHealth = scoreAttributeNullHealth({ fields: _layerFields, fieldStats });
      render();
    });
  }

  // ── Render / re-render card body ──
  function render() {
    const full = computeFullScore({ basics, steward, webService, dataStandard, stage, issues, serviceMetadata, serviceCapabilities, nullHealth, freshnessConfidence });
    const tierMeta = TIER_META[full.tier] || TIER_META.bronze;

    // Update card border color
    const borderColors = { platinum: '#b4dcff', gold: '#fde047', silver: '#d4d4d4', bronze: '#d4a574' };
    card.style.borderLeftColor = borderColors[full.tier] || 'var(--text-muted)';

    let html = '';

    // ── Score summary ──
    html += `
      <div class="maturity-score-summary">
        <div class="tier-badge-large ${tierMeta.css}">${tierMeta.icon}<span>${escapeHtml(tierMeta.label)}</span></div>
        <div class="maturity-score-value">
          <span class="maturity-score-number">${full.total}</span><span class="maturity-score-total">/100</span>
          ${full.hasPending ? '<span class="maturity-pending-badge">analyzing\u2026</span>' : ''}
        </div>
      </div>
      <div class="completeness-bar-container" style="margin-bottom:1rem;">
        <div class="completeness-bar-track">
          <div class="completeness-bar-fill" style="width:${full.total}%; background:${barColor(full.total)};"></div>
        </div>
      </div>
    `;

    // ── Sub-scores (used for details + suggestions, not rendered as bars) ──
    const subs = [
      { key: 'basics',              label: 'Catalog Basics',          data: basics },
      { key: 'steward',             label: 'Data Steward',            data: steward },
      { key: 'webService',          label: 'Web Service URL',         data: webService },
      { key: 'dataStandard',        label: 'Data Standard',           data: dataStandard },
      { key: 'stage',               label: 'Development Stage',       data: stage },
      { key: 'issues',              label: 'Blockers & Improvements', data: issues },
      { key: 'serviceMetadata',     label: 'Service Metadata',        data: serviceMetadata },
      { key: 'serviceCapabilities', label: 'Service Capabilities',    data: serviceCapabilities },
      { key: 'nullHealth',          label: 'Attribute Null Health',   data: nullHealth },
      { key: 'freshnessConfidence', label: 'Freshness Confidence',    data: freshnessConfidence },
    ];

    // ── Collapsible details ──
    html += '<details class="maturity-details-toggle">';
    html += '<summary>Score Details</summary>';
    html += '<div class="maturity-details-content">';
    subs.forEach(sub => {
      const target = SCROLL_TARGETS[sub.key] || '';
      const headingLink = target
        ? `<a href="#" class="maturity-scroll-link" data-scroll-target="${escapeHtml(target)}">${escapeHtml(sub.label)}</a>`
        : escapeHtml(sub.label);
      html += `<h5>${headingLink} <span class="maturity-subscore-inline">${sub.data.score}/${sub.data.max}</span></h5><ul class="maturity-check-list">`;
      sub.data.details.forEach(d => {
        if (d.pending) {
          html += `<li class="maturity-check-pending">\u2022 ${escapeHtml(d.label)}</li>`;
        } else if (d.isPenalty) {
          html += `<li class="maturity-check-penalty">\u2716 ${escapeHtml(d.label)} (${d.pts})</li>`;
        } else if (d.ok) {
          html += `<li class="maturity-check-ok">\u2713 ${escapeHtml(d.label)}${d.maxPts ? ` (+${d.pts})` : ''}</li>`;
        } else {
          html += `<li class="maturity-check-missing">\u2717 ${escapeHtml(d.label)}</li>`;
        }
      });
      html += '</ul>';
    });
    html += '</div></details>';

    // ── Improvement suggestions ──
    const suggestions = generateSuggestions(subs);
    if (suggestions.length) {
      html += '<div class="maturity-suggestions">';
      html += '<div class="suggestions-header"><strong>Suggestions to improve:</strong></div>';
      html += '<ul class="suggestions-list">';
      suggestions.forEach(s => {
        const target = s._scrollTarget || '';
        if (target) {
          html += `<li><a href="#" class="maturity-scroll-link" data-scroll-target="${escapeHtml(target)}">${escapeHtml(s.text)}</a></li>`;
        } else {
          html += `<li>${escapeHtml(s.text)}</li>`;
        }
      });
      html += '</ul></div>';
    }

    body.innerHTML = html;

    // Wire scroll-link click handlers
    body.querySelectorAll('.maturity-scroll-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const selector = link.getAttribute('data-scroll-target');
        if (!selector) return;
        const targetEl = hostEl.querySelector(selector);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetEl.classList.add('maturity-highlight');
          setTimeout(() => targetEl.classList.remove('maturity-highlight'), 2000);
        }
      });
    });
  }
}

// ── Helpers ──

function barColor(pct) {
  if (pct >= 80) return 'var(--green, #10b981)';
  if (pct >= 60) return 'var(--amber, #f59e0b)';
  return 'var(--red, #ef4444)';
}

// Maps sub-score keys to CSS selectors for scrolling to the relevant section
const SCROLL_TARGETS = {
  basics:              '[data-field-key="title"]',
  steward:             '[data-field-key="contact_email"]',
  webService:          '[data-field-key="public_web_service"]',
  dataStandard:        '[data-field-key="data_standard"]',
  stage:               '[data-field-key="development_stage"]',
  issues:              '[data-field-key="blockers"]',
  serviceMetadata:     '#serviceMetadataCard',
  serviceCapabilities: '#serviceMetadataCard',
  nullHealth:          '#fieldsCard',
  freshnessConfidence: '#freshnessCard',
};

/**
 * Generate actionable suggestions from the sub-score details.
 * Returns the top few most impactful suggestions.
 */
function generateSuggestions(subs) {
  const suggestions = [];

  subs.forEach(sub => {
    sub.data.details.forEach(d => {
      if (d.pending || d.ok) return;
      const s = suggestFor(sub.key, d);
      if (s) suggestions.push({ text: s, _scrollTarget: SCROLL_TARGETS[sub.key] || '' });
    });
  });

  return suggestions.slice(0, 5);
}

function suggestFor(category, detail) {
  if (category === 'basics') {
    if (detail.key && !detail.ok) return `Fill in "${detail.label}" in catalog metadata`;
  }
  if (category === 'steward') return 'Add a Contact Email to assign a data steward';
  if (category === 'webService') return 'Provide a Web Service URL for data access';
  if (category === 'dataStandard') return 'Link a Data Standard document';
  if (category === 'stage') {
    if (detail.label?.includes('Not set')) return 'Set a Development Stage';
    if (!detail.ok) return 'Advance the dataset toward Production stage';
  }
  if (category === 'issues') {
    if (detail.isPenalty && detail.label?.includes('blocker')) return 'Resolve open blockers';
    if (detail.isPenalty && detail.label?.includes('improvement')) return 'Address noted improvements';
  }
  if (category === 'serviceMetadata') return `Add ${detail.label} to the ArcGIS service`;
  if (category === 'serviceCapabilities') return detail.label ? `Enable ${detail.label} on the service` : null;
  if (category === 'nullHealth') {
    if (detail.label?.includes('null rate')) return 'Reduce null values in attribute columns';
    if (detail.label?.includes('over 80%')) return 'Remove or populate nearly-empty columns';
  }
  if (category === 'freshnessConfidence') {
    if (detail.label?.includes('No freshness')) return 'Ensure the web service exposes edit tracking or date fields so freshness can be detected';
    if (!detail.ok) return 'Enable editor tracking on the service to improve freshness detection confidence';
  }
  return null;
}
