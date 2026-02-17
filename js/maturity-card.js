// maturity-card.js — Renders and manages the auto-computed Data Maturity card.
// Initializes with instant sub-scores (catalog, coverage, docs),
// then updates live when service/field data arrives via CustomEvents.

import { escapeHtml } from './utils.js';
import {
  scoreCatalogCompleteness,
  scoreServiceHealth,
  scoreAttributeQuality,
  scoreCoverage,
  scoreDocumentation,
  computeFullScore,
  tierFromScore,
  TIER_META,
} from './maturity-score.js';

// ── Card HTML placeholder (inserted by detail.js) ──

export function maturityCardHTML() {
  return `
    <div class="card card-maturity" id="maturityScoreCard" style="border-left:4px solid var(--text-muted);">
      <div class="card-header-row">
        <h3>\uD83D\uDCCA Data Maturity</h3>
        <span class="data-source-badge data-source-badge-auto">Auto</span>
      </div>
      <p class="text-muted" style="margin-bottom:0.75rem;font-size:0.85rem;">
        Automated quality assessment based on catalog metadata, service capabilities, attribute schema, and spatial coverage.
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
  const catalog = scoreCatalogCompleteness(dataset);
  const coverage = scoreCoverage(dataset);
  const docs = scoreDocumentation(dataset);

  // Service + attribute quality start as pending (or N/A if no service)
  let service = hasService
    ? { score: 0, max: 25, pending: true, details: [{ label: 'Analyzing service\u2026', ok: false, pts: 0, maxPts: 25 }] }
    : { score: 0, max: 25, details: [{ label: 'No public web service configured', ok: false, pts: 0, maxPts: 25 }] };

  let attributes = hasService
    ? { score: 0, max: 25, pending: true, details: [{ label: 'Analyzing attribute schema\u2026', ok: false, pts: 0, maxPts: 25 }] }
    : { score: 0, max: 25, details: [{ label: 'No service to analyze', ok: false, pts: 0, maxPts: 25 }] };

  // Stash fields for later stats update
  let _layerFields = null;

  render();

  // ── Listen for live service data ──
  if (hasService) {
    hostEl.addEventListener('maturity:service-data', (e) => {
      const { serviceJson, layerJson } = e.detail || {};
      service = scoreServiceHealth({ serviceJson, layerJson });
      // Compute partial attribute quality from field metadata (no stats yet)
      _layerFields = layerJson?.fields || null;
      attributes = scoreAttributeQuality({ fields: _layerFields, fieldStats: null, totalCount: 0 });
      render();
    });

    hostEl.addEventListener('maturity:field-stats', (e) => {
      const { fieldStats, totalCount } = e.detail || {};
      // Re-score attribute quality with full stats
      attributes = scoreAttributeQuality({ fields: _layerFields, fieldStats, totalCount });
      render();
    });
  }

  // ── Render / re-render card body ──
  function render() {
    const full = computeFullScore({ catalog, service, attributes, coverage, docs });
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
      { key: 'catalog',    label: 'Catalog Completeness',     data: catalog },
      { key: 'service',    label: 'Service Health',           data: service },
      { key: 'attributes', label: 'Attribute Table Quality',  data: attributes },
      { key: 'coverage',   label: 'Coverage',                 data: coverage },
      { key: 'docs',       label: 'Documentation',            data: docs },
    ];

    html += '<div class="maturity-subscores">';
    subs.forEach(sub => {
      const d = sub.data;
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
      if (d.pending || d.ok || d.isPenalty) return;
      // Map failing checks to actionable suggestions
      const s = suggestFor(sub.key, d);
      if (s) suggestions.push(s);
    });
  });

  // Cap at 5 most impactful
  return suggestions.slice(0, 5);
}

function suggestFor(category, detail) {
  if (category === 'catalog') {
    if (!detail.present && detail.key) {
      const friendly = detail.label || detail.key;
      return `Add "${friendly}" to catalog metadata`;
    }
  }
  if (category === 'service') {
    return detail.label ? `Service: ${detail.label}` : null;
  }
  if (category === 'attributes') {
    if (detail.label?.includes('aliases')) return 'Add human-readable aliases to service fields';
    if (detail.label?.includes('null')) return 'Reduce null values in attribute columns';
    if (detail.label?.includes('width')) return 'Consider reducing the number of fields in the service';
    if (detail.label?.includes('domains')) return 'Add coded value domains to low-cardinality fields';
    return null;
  }
  if (category === 'coverage') {
    return 'Run coverage analysis (generate-coverage.js) to populate spatial coverage data';
  }
  if (category === 'docs') {
    if (detail.label?.includes('Attribute IDs')) return 'Link attribute definitions to this dataset via attribute_ids';
    if (detail.label?.includes('definitions')) return 'Add definitions to linked attributes';
    if (detail.label?.includes('Expected')) return 'Add expected_value examples to attributes';
    if (detail.label?.includes('Enum')) return 'Document enumerated value lists for enumerated-type attributes';
    return null;
  }
  return null;
}
