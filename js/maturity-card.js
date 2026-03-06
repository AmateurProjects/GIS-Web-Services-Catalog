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
  computeFullScore,
  tierFromScore,
  TIER_META,
} from './maturity-score.js';

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
export function initMaturityCard(hostEl, dataset, hasService) {
  const card = hostEl.querySelector('#maturityScoreCard');
  if (!card) return;
  const body = card.querySelector('[data-maturity-body]');
  if (!body) return;

  // ── Compute instant sub-scores ──
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
    const full = computeFullScore({ basics, steward, webService, dataStandard, stage, issues, serviceMetadata, serviceCapabilities, nullHealth });
    const tierMeta = TIER_META[full.tier] || TIER_META.bronze;

    // Update card border color
    const borderColors = { gold: '#fde047', silver: '#d4d4d4', bronze: '#d4a574' };
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

    // ── Sub-scores ──
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
    ];

    html += '<div class="maturity-subscores">';
    subs.forEach(sub => {
      const d = sub.data;
      // For penalty-only categories (max=0), show as a tag not a bar
      if (d.max === 0) {
        if (d.score < 0) {
          html += `
            <div class="maturity-subscore-item">
              <div class="maturity-subscore-header">
                <span class="maturity-subscore-label">${escapeHtml(sub.label)}</span>
                <span class="maturity-subscore-value" style="color:var(--red, #ef4444);">${d.score}</span>
              </div>
            </div>
          `;
        }
        // If no penalty, skip showing this row entirely
        return;
      }
      const pct = d.max > 0 ? Math.round((d.score / d.max) * 100) : 0;
      const pending = d.pending ? ' <span class="maturity-pending-badge">analyzing\u2026</span>' : '';
      html += `
        <div class="maturity-subscore-item">
          <div class="maturity-subscore-header">
            <span class="maturity-subscore-label">${escapeHtml(sub.label)}${pending}</span>
            <span class="maturity-subscore-value">${d.score}/${d.max}</span>
          </div>
          <div class="completeness-bar-track small">
            <div class="completeness-bar-fill" style="width:${pct}%; background:${barColor(pct)};"></div>
          </div>
        </div>
      `;
    });
    html += '</div>';

    // ── Collapsible details ──
    html += '<details class="maturity-details-toggle">';
    html += '<summary>Score Details</summary>';
    html += '<div class="maturity-details-content">';
    subs.forEach(sub => {
      html += `<h5>${escapeHtml(sub.label)}</h5><ul class="maturity-check-list">`;
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
      suggestions.forEach(s => { html += `<li>${escapeHtml(s)}</li>`; });
      html += '</ul></div>';
    }

    body.innerHTML = html;
  }
}

// ── Helpers ──

function barColor(pct) {
  if (pct >= 80) return 'var(--green, #10b981)';
  if (pct >= 60) return 'var(--amber, #f59e0b)';
  return 'var(--red, #ef4444)';
}

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
      if (s) suggestions.push(s);
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
  return null;
}
