import { state, els } from './state.js';
import { escapeHtml } from './utils.js';
import { setActiveListButton } from './ui-fx.js';
import { runUrlChecks, setCachedUrlStatus } from './url-check.js';
import { normalizeServiceUrl, parseServiceAndLayerId, maybeRenderPublicServicePreviewCard, incrementRenderGeneration, getCurrentMapView, setCurrentMapView } from './arcgis-preview.js';
import { WORKER_BASE_URL } from './config.js';
import { renderCoverageMapCard, getCoverageCache } from './coverage-map.js';
import { getDatasetById, getAttributeById, getAttributesForDataset, getDatasetsForAttribute } from './catalog.js';
import { showDatasetsView, showAttributesView } from './navigation.js';
import { wireDatasetInlineEdit, enterAttributeEditMode } from './edit-mode.js';
import { applyDashboardFilter } from './filters.js';
import { maturityCardHTML, initMaturityCard } from './maturity-card.js';
import { getFieldInfo, shortTypeName, typeColor, isFieldIndexLoaded } from './field-explorer.js';
import { setLastSelectedFieldName } from './lists.js';
import { getConfidenceMeta, getSignalLabel, formatFreshnessAge, freshnessColor, detectFreshness } from './freshness.js';
import { wireExportButtons } from './metadata-export.js';

// ── Freshness data cache (loaded from data/freshness.json once) ──
let _freshnessIndex = null;  // { datasets: [...] } or null
let _freshnessIndexLoading = false;

async function loadFreshnessIndex() {
  if (_freshnessIndex) return _freshnessIndex;
  if (_freshnessIndexLoading) return null;
  _freshnessIndexLoading = true;
  try {
    const resp = await fetch('data/freshness.json');
    if (resp.ok) {
      _freshnessIndex = await resp.json();
    }
  } catch (_) { /* no pre-computed data */ }
  _freshnessIndexLoading = false;
  return _freshnessIndex;
}

export function getFreshnessIndex() { return _freshnessIndex; }

// ── Health data cache (loaded from Worker R2 health.json once) ──
let _healthCache = undefined; // undefined = not attempted

async function loadHealthCache() {
  if (_healthCache !== undefined) return _healthCache;
  try {
    const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
    if (!workerBase) { _healthCache = null; return null; }
    const resp = await fetch(`${workerBase}/health.json`);
    if (!resp.ok) { _healthCache = null; return null; }
    _healthCache = await resp.json();
    return _healthCache;
  } catch {
    _healthCache = null;
    return null;
  }
}

/** Pre-seed url-check cache with Worker health results. */
async function seedHealthFromCache() {
  const health = await loadHealthCache();
  if (!health || !health.services) return;
  for (const svc of health.services) {
    if (!svc.url) continue;
    // Only pre-seed "ok" results from the Worker cache.
    // "bad" and "unknown" results may be stale (Worker runs twice daily),
    // so let the browser re-check those live for fresher accuracy.
    if (svc.status === 'ok') {
      setCachedUrlStatus(svc.url, svc.status, svc.detail || '');
    }
  }
}

export function renderDatasetDetail(datasetId) {
    if (!els.datasetDetailEl) return;

  // Increment render generation so stale async operations (preview, coverage) bail out
  const currentGeneration = incrementRenderGeneration();

  // Destroy any existing ArcGIS MapView to prevent memory leaks
  if (getCurrentMapView()) {
    getCurrentMapView().destroy();
    setCurrentMapView(null);
  }

  // Browsing existing datasets should not animate.
  // Also make sure no prior FX classes linger from edit/create flows.
  els.datasetDetailEl.classList.remove('fx-enter', 'fx-animating');

    // update "last selected dataset" state whenever we render a dataset detail
    state.lastSelectedDatasetId = datasetId;

    // Update URL hash for deep linking (replace to avoid polluting history on every click)
    const targetHash = `#dataset/${encodeURIComponent(datasetId)}`;
    if (window.location.hash !== targetHash) {
      history.replaceState(null, '', targetHash);
    }

   // highlight active dataset in sidebar (if list is rendered)
   setActiveListButton(els.datasetListEl, (b) => b.getAttribute('data-ds-id') === datasetId);

    const dataset = getDatasetById(datasetId);
    if (!dataset) {
      els.datasetDetailEl.classList.remove('hidden');
      els.datasetDetailEl.innerHTML = `<p>Dataset not found: ${escapeHtml(datasetId)}</p>`;
      return;
    }

    const attrs = getAttributesForDataset(dataset);

    let html = '';

    // Sticky header with dataset name + export dropdown
    html += `<div class="detail-sticky-header">
      <h2>${escapeHtml(dataset.title || dataset.id)}</h2>
      <div class="detail-header-actions">
        <div class="export-dropdown" id="exportDropdown">
          <button type="button" class="btn btn-export-trigger" data-export-toggle>📤 Export</button>
          <div class="export-dropdown-menu" id="exportDropdownMenu">
            <button type="button" class="export-dropdown-item" data-export-format="dcat" data-export-ds="${escapeHtml(dataset.id)}">DCAT-US JSON-LD</button>
            <button type="button" class="export-dropdown-item" data-export-format="schema" data-export-ds="${escapeHtml(dataset.id)}">Schema.org JSON-LD</button>
            <button type="button" class="export-dropdown-item" data-export-format="iso" data-export-ds="${escapeHtml(dataset.id)}">ISO 19115 XML</button>
          </div>
        </div>
      </div>
    </div>`;

    // Auto-computed Data Maturity card (initialized after innerHTML is set — appears first)
    html += maturityCardHTML();

    // Helper for simple editable field rows
    const ef = (label, key, val) => {
      const isEmpty = val === undefined || val === null || val === '';
      const display = isEmpty ? '<span style="color:var(--text-muted);font-style:italic;">—</span>' : escapeHtml(String(val));
      return `<div class="inline-edit-row"><span class="inline-edit-label">${label}</span><span class="inline-edit-cell editable-field" data-field-key="${key}"><span class="inline-edit-value">${display}</span></span></div>`;
    };

    html += '<div class="card card-meta">';
    html += '<div class="card-header-row"><h3>Dataset Information</h3></div>';
    html += `<p class="edit-admin-note" style="font-size:0.75rem;color:var(--text-muted);margin:0 0 0.75rem;font-style:italic;">✏️ Click any field value to edit. Saving requires admin access.</p>`;
    
    // === Catalog Metadata Section ===
    html += '<div class="manual-section">';
    html += '<h4 class="manual-section-title">Catalog Metadata</h4>';
    html += ef('Dataset Name', 'title', dataset.title || dataset.id);
    html += ef('Description', 'description', dataset.description);
    html += ef('Agency Owner', 'agency_owner', dataset.agency_owner);
    html += ef('Office Owner', 'office_owner', dataset.office_owner);
    html += ef('Contact Email', 'contact_email', dataset.contact_email);

    const topicsHtml = Array.isArray(dataset.topics) && dataset.topics.length
      ? dataset.topics.map(t => `<button type="button" class="pill pill-topic pill-clickable" data-topic-filter="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join(' ')
      : '<span style="color:var(--text-muted);font-style:italic;">—</span>';
    html += `<div class="inline-edit-row"><span class="inline-edit-label">Topics</span><span class="inline-edit-cell editable-field" data-field-key="topics"><span class="inline-edit-value">${topicsHtml}</span></span></div>`;

    html += ef('Update Frequency', 'update_frequency', dataset.update_frequency);
    html += ef('Notes', 'notes', dataset.notes);
    html += '</div>'; // end Catalog Metadata section

    // === Data Access Section ===
    html += '<div class="manual-section">';
    html += '<h4 class="manual-section-title">Data Access</h4>';

    html += `<div class="inline-edit-row url-check-row" data-url-check-row data-url="${escapeHtml(dataset.public_web_service || '')}" data-url-status="idle"><span class="url-status-icon" aria-hidden="true"></span><span class="inline-edit-label">Public Web Service</span><span class="inline-edit-cell editable-field" data-field-key="public_web_service"><span class="inline-edit-value">${
      dataset.public_web_service
        ? `<a href="${dataset.public_web_service}" target="_blank" rel="noopener">${escapeHtml(dataset.public_web_service)}</a>`
        : '<span style="color:var(--text-muted);font-style:italic;">—</span>'
    }</span></span></div>`;

    html += `<div class="inline-edit-row url-check-row" data-url-check-row data-url="${escapeHtml(dataset.internal_web_service || '')}" data-url-status="idle"><span class="url-status-icon" aria-hidden="true"></span><span class="inline-edit-label">Internal Web Service</span><span class="inline-edit-cell editable-field" data-field-key="internal_web_service"><span class="inline-edit-value">${
      dataset.internal_web_service
        ? `<a href="${dataset.internal_web_service}" target="_blank" rel="noopener">${escapeHtml(dataset.internal_web_service)}</a>`
        : '<span style="color:var(--text-muted);font-style:italic;">—</span>'
    }</span></span></div>`;

    if (dataset.data_standard && /^https?:\/\//i.test(dataset.data_standard)) {
      html += `<div class="inline-edit-row url-check-row" data-url-check-row data-url="${escapeHtml(dataset.data_standard)}" data-url-status="idle"><span class="url-status-icon" aria-hidden="true"></span><span class="inline-edit-label">Data Standard</span><span class="inline-edit-cell editable-field" data-field-key="data_standard"><span class="inline-edit-value"><a href="${escapeHtml(dataset.data_standard)}" target="_blank" rel="noopener">${escapeHtml(dataset.data_standard)}</a></span></span></div>`;
    } else {
      html += ef('Data Standard', 'data_standard', dataset.data_standard);
    }

    html += ef('Access Level', 'access_level', dataset.access_level);
    html += '</div>'; // end Data Access section

    // === Development & Status Section ===
    html += '<div class="manual-section">';
    html += '<h4 class="manual-section-title">Development & Status</h4>';

    const stageLabels = {
      'planned': { label: 'Planned', class: 'stage-planned' },
      'in_development': { label: 'In Development', class: 'stage-dev' },
      'qa': { label: 'QA/Testing', class: 'stage-qa' },
      'production': { label: 'Production', class: 'stage-prod' },
      'deprecated': { label: 'Deprecated', class: 'stage-deprecated' }
    };
    const stage = dataset.development_stage || 'unknown';
    const stageInfo = stageLabels[stage] || { label: stage, class: '' };
    html += `<div class="inline-edit-row"><span class="inline-edit-label">Development Stage</span><span class="inline-edit-cell editable-field" data-field-key="development_stage"><span class="inline-edit-value"><span class="stage-badge ${stageInfo.class}">${escapeHtml(stageInfo.label)}</span></span></span></div>`;

    html += ef('Target Release Date', 'target_release_date', dataset.target_release_date);

    const blockersDisplay = Array.isArray(dataset.blockers) && dataset.blockers.length
      ? escapeHtml(dataset.blockers.join(', '))
      : '<span style="color:var(--text-muted);font-style:italic;">—</span>';
    html += `<div class="inline-edit-row"><span class="inline-edit-label">Blockers</span><span class="inline-edit-cell editable-field" data-field-key="blockers"><span class="inline-edit-value">${blockersDisplay}</span></span></div>`;

    const improvementsDisplay = Array.isArray(dataset.improvements) && dataset.improvements.length
      ? escapeHtml(dataset.improvements.join(', '))
      : '<span style="color:var(--text-muted);font-style:italic;">—</span>';
    html += `<div class="inline-edit-row"><span class="inline-edit-label">Improvements Needed</span><span class="inline-edit-cell editable-field" data-field-key="improvements"><span class="inline-edit-value">${improvementsDisplay}</span></span></div>`;

    html += '</div>'; // end Development & Status section

    // === Optional Section ===
    html += '<div class="manual-section">';
    html += '<h4 class="manual-section-title">Optional</h4>';
    html += ef('Database Object Name', 'objname', dataset.objname);
    html += '</div>'; // end Optional section

    // Save button area (hidden by default, shown when edits are pending)
    html += `<div class="manual-section-actions dataset-save-actions" style="display:none;">
      <span class="edit-change-count" style="font-size:0.85rem;color:var(--text-muted);"></span>
      <div style="display:flex;gap:0.5rem;">
        <button type="button" class="btn" data-discard-edits>Discard</button>
        <button type="button" class="btn primary" data-save-edits>💾 Save</button>
      </div>
    </div>`;

    html += '</div>'; // end combined manual card

    // Coverage Map card (populated asynchronously by renderCoverageMapCard)
    html += '<div class="card card-coverage" id="coverageMapCard">';
    html += '<div class="card-header-row"><h3>\uD83D\uDDFA\uFE0F Coverage Map</h3><div style="display:flex;align-items:center;gap:0.5rem;"><button type="button" class="btn" data-cov-refresh title="Re-run live coverage analysis" style="padding:0.25rem 0.6rem;font-size:0.78rem;">&#x21bb; Refresh</button></div></div>';
    html += '<p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">Spatial intersection with <a href="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0" target="_blank" rel="noopener">Census Bureau TIGER state boundaries</a>. A 0.5 mile inward buffer is applied to each state boundary to exclude sliver intersections along shared borders. Counts are approximate.</p>';
    html += '<div data-cov-status class="coverage-status">Waiting for analysis\u2026</div>';
    html += '<div data-cov-content></div>';
    html += '</div>';

    // Freshness / last-updated card (async)
    html += `
      <div class="card card-freshness" id="freshnessCard">
        <div class="card-header-row"><h3>🕐 Data Freshness</h3></div>
        <p class="text-muted" data-freshness-subtitle style="font-size:0.85rem;margin-bottom:0.5rem;">Multi-signal detection of when this dataset was last updated.</p>
        <div data-freshness-content>
          <p class="loading-message" style="font-size:0.85rem;">Detecting freshness…</p>
        </div>
      </div>
    `;

    // Attributes + inline attribute details - only show if dataset has attributes
    if (attrs.length > 0) {
      html += `
        <div class="card-row">
          <div class="card card-attributes">
            <div class="card-header-row"><h3>Attributes</h3></div>
            <ul>
      `;
      attrs.forEach((attr) => {
        html += `
            <li>
              <button type="button" class="link-button" data-attr-id="${escapeHtml(attr.id)}">
                ${escapeHtml(attr.id)} – ${escapeHtml(attr.label || '')}
              </button>
            </li>`;
      });
      html += `
            </ul>
          </div>
          <div class="card card-inline-attribute" id="inlineAttributeDetail">
            <h3>Attribute details</h3>
            <p>Select an attribute from the list to see its properties here without leaving this dataset.</p>
          </div>
        </div>
      `;
    }

// --- Public Web Service preview card (renders after URL checks) ---
html += `
  <div class="card card-map-preview" id="datasetPreviewCard">
    <div class="card-header-row"><h3>Public Web Service Preview</h3></div>
    <p class="text-muted" data-preview-subtitle style="font-size:0.85rem;margin-bottom:0.5rem;">Live data fetched from the ArcGIS REST endpoint.</p>
    <div class="map-preview-status" data-preview-status>
      Checking Public Web Service…
    </div>
    <div class="map-preview-content" data-preview-content></div>
  </div>
`;


    els.datasetDetailEl.innerHTML = html;
    els.datasetDetailEl.classList.remove('hidden');

// Initialize auto-computed maturity card (listens for service data events)
initMaturityCard(els.datasetDetailEl, dataset, !!dataset.public_web_service);

// Check URL status icons (async — pre-seed from Worker health cache first)
seedHealthFromCache().then(() => runUrlChecks(els.datasetDetailEl));

// Load service preview immediately (don't wait for URL health check)
maybeRenderPublicServicePreviewCard(els.datasetDetailEl, dataset.public_web_service, currentGeneration, { datasetId: dataset.id });

// Run coverage map analysis (async, renders into the #coverageMapCard placeholder)
renderCoverageMapCard(els.datasetDetailEl, dataset.public_web_service, currentGeneration, dataset);

// Wire up coverage map refresh button (re-runs live analysis, bypassing pre-computed data)
const covRefreshBtn = els.datasetDetailEl.querySelector('button[data-cov-refresh]');
if (covRefreshBtn) {
  covRefreshBtn.addEventListener('click', () => {
    const _url = normalizeServiceUrl(dataset.public_web_service);
    if (!_url) return;
    const _parsed = parseServiceAndLayerId(_url);
    const _lid = _parsed.isLayerUrl ? _parsed.layerId : 0;
    getCoverageCache().delete(`${_url}__${_lid}`);
    // Clear existing content while re-running
    const _card = els.datasetDetailEl.querySelector('#coverageMapCard');
    if (_card) {
      const _s = _card.querySelector('[data-cov-status]');
      const _c = _card.querySelector('[data-cov-content]');
      if (_s) _s.textContent = 'Re-running live coverage analysis\u2026';
      if (_c) _c.innerHTML = '';
    }
    // Pass null for dataset to skip pre-computed data and force live analysis
    renderCoverageMapCard(els.datasetDetailEl, dataset.public_web_service, currentGeneration, null);
  });
}

    // Wire inline edit on all editable fields in the Dataset Information card
    wireDatasetInlineEdit(dataset, () => renderDatasetDetail(datasetId));

    const rootBtn = els.datasetDetailEl.querySelector('button[data-breadcrumb="datasets"]');
    if (rootBtn) rootBtn.addEventListener('click', showDatasetsView);

    const attrButtons = els.datasetDetailEl.querySelectorAll('button[data-attr-id]');
    attrButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const attrId = btn.getAttribute('data-attr-id');
        renderInlineAttributeDetail(attrId);
      });
    });

    // Wire topic pills → filter by topic
    els.datasetDetailEl.querySelectorAll('button[data-topic-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        const topic = btn.getAttribute('data-topic-filter');
        applyDashboardFilter('topics', topic);
      });
    });

    // ── Freshness detection (async) ──
    loadFreshnessCard(els.datasetDetailEl, dataset, currentGeneration);

    // ── Wire metadata export buttons (now in sticky header dropdown) ──
    wireExportButtons(els.datasetDetailEl);

    // ── Wire export dropdown toggle ──
    const exportToggle = els.datasetDetailEl.querySelector('[data-export-toggle]');
    const exportMenu = els.datasetDetailEl.querySelector('#exportDropdownMenu');
    if (exportToggle && exportMenu) {
      exportToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.toggle('open');
      });
      // Close dropdown when clicking anywhere outside
      els.datasetDetailEl.addEventListener('click', (e) => {
        if (!e.target.closest('.export-dropdown')) exportMenu.classList.remove('open');
      });
      // Close after an export item is clicked
      exportMenu.addEventListener('click', () => exportMenu.classList.remove('open'));
    }

  }

/**
 * Load and render the freshness card for a dataset.
 * Runs live multi-signal detection first; falls back to pre-computed cache if live fails.
 */
async function loadFreshnessCard(hostEl, dataset, generation) {
  const contentEl = hostEl.querySelector('[data-freshness-content]');
  const cardEl = hostEl.querySelector('#freshnessCard');
  if (!contentEl) return;

  let result = null;
  let source = null; // 'live' | 'cache'
  let generatedTimestamp = null;

  // ── Try live detection first (simple ~6 requests per dataset) ──
  if (dataset.public_web_service) {
    try {
      const liveResult = await detectFreshness(dataset.public_web_service);
      if (liveResult && liveResult.lastUpdated) {
        result = liveResult;
        source = 'live';
      }
    } catch (_) { /* live failed, fall back to cache */ }
  }

  // ── Fall back to pre-computed cache ──
  if (!result) {
    const index = await loadFreshnessIndex();
    if (index && index.datasets) {
      const precomputed = index.datasets.find(d => d.datasetId === dataset.id);
      if (precomputed) {
        result = precomputed;
        source = 'cache';
        generatedTimestamp = index.generated || null;
      }
    }
  }

  if (!result) {
    contentEl.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);">Could not detect freshness for this dataset (no signals found).</p>';
    return;
  }

  // ── Render freshness result ──
  const confMeta = getConfidenceMeta(result.confidence);
  const age = formatFreshnessAge(result.lastUpdated);
  const ageColor = freshnessColor(result.lastUpdated);

  if (cardEl) cardEl.style.borderLeftColor = ageColor;

  let html = '';
  html += '<div class="freshness-result">';
  html += `<div class="freshness-main-row">`;
  html += `<div class="freshness-age" style="color:${ageColor};">${escapeHtml(age)}</div>`;
  html += `<div class="freshness-confidence">
    <span class="freshness-conf-dot" style="color:${confMeta.color};">${confMeta.icon}</span>
    ${escapeHtml(confMeta.label)}
  </div>`;
  html += `</div>`;

  if (result.lastUpdated) {
    const d = new Date(result.lastUpdated);
    html += `<div class="freshness-date">${d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>`;
  }

  html += `<div class="freshness-signal">Detected via: <strong>${escapeHtml(getSignalLabel(result.signal))}</strong></div>`;
  if (result.details) {
    html += `<div class="freshness-detail">${escapeHtml(result.details)}</div>`;
  }

  // Signal breakdown
  if (result.signals && result.signals.length > 0) {
    html += `<details class="freshness-signals-details">`;
    html += `<summary>All signals (${result.signals.length})</summary>`;
    html += `<table class="freshness-signals-table">`;
    html += `<thead><tr><th>Signal</th><th>Value</th><th>Confidence</th></tr></thead><tbody>`;
    result.signals.forEach(s => {
      const cm = getConfidenceMeta(s.confidence);
      const val = s.value || '—';
      html += `<tr>
        <td>${escapeHtml(getSignalLabel(s.signal))}</td>
        <td style="font-size:0.8rem;">${escapeHtml(typeof val === 'string' && val.length > 40 ? val.slice(0, 37) + '…' : String(val))}</td>
        <td><span style="color:${cm.color};">${cm.icon}</span> ${escapeHtml(cm.label)}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
    html += `</details>`;
  }

  if (result.recordCount !== null && result.recordCount !== undefined) {
    html += `<div class="freshness-record-count">Record count: <strong>${result.recordCount.toLocaleString()}</strong></div>`;
  }

  html += '</div>';

  contentEl.innerHTML = html;

  // Update subtitle with source/date info
  const subtitleEl = hostEl.querySelector('[data-freshness-subtitle]');
  if (subtitleEl) {
    if (source === 'cache' && generatedTimestamp) {
      const genDate = new Date(generatedTimestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      subtitleEl.textContent = `Multi-signal detection of when this dataset was last updated. Generated ${genDate}.`;
    } else if (source === 'live') {
      const now = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      subtitleEl.textContent = `Multi-signal detection of when this dataset was last updated. Detected live ${now}.`;
    }
  }
}

export function renderInlineAttributeDetail(attrId) {
    if (!els.datasetDetailEl) return;

    const container = els.datasetDetailEl.querySelector('#inlineAttributeDetail');
    if (!container) return;

    const attribute = getAttributeById(attrId);
    if (!attribute) {
      container.innerHTML = `
        <h3>Attribute details</h3>
        <p>Attribute not found: ${escapeHtml(attrId)}</p>
      `;
      return;
    }

    const datasetsUsing = getDatasetsForAttribute(attrId) || [];

    let html = '';
    html += '<h3>Attribute details</h3>';
    html += `<h4>${escapeHtml(attribute.id)} – ${escapeHtml(attribute.label || '')}</h4>`;

    html += `<p><strong>Attribute Field Name:</strong> ${escapeHtml(attribute.id)}</p>`;
    html += `<p><strong>Attribute Label:</strong> ${escapeHtml(attribute.label || '')}</p>`;
    html += `<p><strong>Attribute Type:</strong> ${escapeHtml(attribute.type || '')}</p>`;
    html += `<p><strong>Attribute Definition:</strong> ${escapeHtml(attribute.definition || '')}</p>`;
    if (attribute.expected_value !== undefined) {
      html += `<p><strong>Example Expected Value:</strong> ${escapeHtml(String(attribute.expected_value))}</p>`;
    }

    if (attribute.type === 'enumerated' && Array.isArray(attribute.values) && attribute.values.length) {
      html += '<h4>Allowed values</h4>';
      html += `
        <table>
          <thead>
            <tr><th>Code</th><th>Label</th><th>Description</th></tr>
          </thead>
          <tbody>
      `;

      attribute.values.forEach((v) => {
        const code = v.code !== undefined ? String(v.code) : '';
        const label = v.label || '';
        const desc = v.description || '';
        html += `
          <tr>
            <td>${escapeHtml(code)}</td>
            <td>${escapeHtml(label)}</td>
            <td>${escapeHtml(desc)}</td>
          </tr>
        `;
      });

      html += `
          </tbody>
        </table>
      `;
    }

    html += '<h4>Datasets using this attribute</h4>';
    if (!datasetsUsing.length) {
      html += '<p>No other datasets currently reference this attribute.</p>';
    } else {
      html += '<ul>';
      datasetsUsing.forEach((ds) => {
        html += `
          <li>
            <button type="button" class="link-button" data-dataset-id="${escapeHtml(ds.id)}">
              ${escapeHtml(ds.title || ds.id)}
            </button>
          </li>
        `;
      });
      html += '</ul>';
    }

    html += `
      <p style="margin-top:0.6rem;">
        <button type="button" class="link-button" data-open-full-attribute="${escapeHtml(attribute.id)}">
          Open full attribute page
        </button>
      </p>
    `;

    container.innerHTML = html;

    const openFullBtn = container.querySelector('button[data-open-full-attribute]');
    if (openFullBtn) {
      openFullBtn.addEventListener('click', () => {
        const id = openFullBtn.getAttribute('data-open-full-attribute');
        showAttributesView();
        renderAttributeDetail(id);
      });
    }

    const dsButtons = container.querySelectorAll('button[data-dataset-id]');
    dsButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const dsId = btn.getAttribute('data-dataset-id');
        showDatasetsView();
        // keep lastSelectedDatasetId in sync on navigation
        state.lastSelectedDatasetId = dsId;
        renderDatasetDetail(dsId);
      });
    });
  }

export function renderAttributeDetail(attrIdOrFieldName) {
    if (!els.attributeDetailEl) return;

  // Browsing existing attributes should not animate.
  els.attributeDetailEl.classList.remove('fx-enter', 'fx-animating');

  // ── Try legacy manual attribute first ──
  const attribute = getAttributeById(attrIdOrFieldName);
  if (attribute) {
    _renderLegacyAttributeDetail(attribute);
    return;
  }

  // ── Field Explorer path: show cross-dataset field info ──
  if (isFieldIndexLoaded()) {
    const fieldInfo = getFieldInfo(attrIdOrFieldName);
    if (fieldInfo) {
      _renderFieldExplorerDetail(fieldInfo);
      return;
    }
  }

  // Not found in either
  els.attributeDetailEl.classList.remove('hidden');
  els.attributeDetailEl.innerHTML = `<p style="padding:1rem;color:var(--text-muted);">Field not found: ${escapeHtml(attrIdOrFieldName)}</p>`;
}

function _renderFieldExplorerDetail(field) {
  setLastSelectedFieldName(field.name);

  // Set URL hash for deep linking
  const targetHash = `#field/${encodeURIComponent(field.name)}`;
  if (window.location.hash !== targetHash) {
    history.replaceState(null, '', targetHash);
  }

  // Highlight active field in sidebar
  setActiveListButton(els.attributeListEl, (b) => b.getAttribute('data-field-name') === field.name);

  const shortType = shortTypeName(field.primaryType);
  const tColor = typeColor(shortType);
  const hasMultipleTypes = field.types.length > 1;

  let html = '';

  // Header
  html += `<h2 class="field-detail-title">${escapeHtml(field.name)}</h2>`;
  if (field.primaryAlias && field.primaryAlias !== field.name) {
    html += `<p class="field-detail-alias">${escapeHtml(field.primaryAlias)}</p>`;
  }

  // Overview stats card
  html += '<div class="card card-field-overview">';
  html += '<h3>Field Overview</h3>';
  html += '<div class="field-stats-row">';

  // Dataset count
  html += `
    <div class="field-stat">
      <div class="field-stat-value" style="color:var(--accent);">${field.datasetCount}</div>
      <div class="field-stat-label">Dataset${field.datasetCount !== 1 ? 's' : ''}</div>
    </div>`;

  // Primary type
  html += `
    <div class="field-stat">
      <div class="field-stat-value"><span class="field-type-badge" style="background:${tColor};font-size:0.9rem;">${escapeHtml(shortType)}</span></div>
      <div class="field-stat-label">Primary Type</div>
    </div>`;

  // Avg null %
  if (field.avgNullPct !== null && field.avgNullPct !== undefined) {
    const nullColor = field.avgNullPct < 10 ? 'var(--green)' : field.avgNullPct < 40 ? 'var(--amber)' : 'var(--red)';
    html += `
      <div class="field-stat">
        <div class="field-stat-value" style="color:${nullColor};">${field.avgNullPct}%</div>
        <div class="field-stat-label">Avg Null Rate</div>
      </div>`;
  }

  // Domain
  if (field.hasDomain) {
    html += `
      <div class="field-stat">
        <div class="field-stat-value" style="color:var(--purple);">Yes</div>
        <div class="field-stat-label">Has Domain</div>
      </div>`;
  }

  html += '</div>'; // end field-stats-row

  // Type consistency warning
  if (hasMultipleTypes) {
    html += `<div class="field-type-warning">
      <strong>\u26A0 Type inconsistency:</strong> This field uses different types across datasets:
      ${field.types.map(t => {
        const st = shortTypeName(t);
        return `<span class="field-type-badge" style="background:${typeColor(st)}">${escapeHtml(st)}</span>`;
      }).join(' ')}
    </div>`;
  }

  // Alias variants
  if (field.aliases.length > 1) {
    html += `<div class="field-alias-variants">
      <strong>Alias variants:</strong> ${field.aliases.map(a => `<code>${escapeHtml(a)}</code>`).join(', ')}
    </div>`;
  }

  html += '</div>'; // end overview card

  // Dataset table card
  html += '<div class="card card-field-datasets">';
  html += `<h3>Datasets Using This Field <span class="field-dataset-table-count">${field.datasetCount}</span></h3>`;

  if (field.datasets.length) {
    html += `
      <div class="field-dataset-table-wrapper">
      <table class="field-dataset-table">
        <thead>
          <tr>
            <th>Dataset</th>
            <th>Type</th>
            <th>Alias</th>
            <th>Null %</th>
            <th>Distinct</th>
            <th>Quality</th>
            <th>Domain</th>
          </tr>
        </thead>
        <tbody>`;

    field.datasets.forEach(d => {
      const st = shortTypeName(d.type);
      const tc = typeColor(st);
      const nullVal = d.nullPct !== null && d.nullPct !== undefined ? `${d.nullPct}%` : '\u2014';
      const nullColor = d.nullPct !== null
        ? (d.nullPct < 10 ? 'var(--green)' : d.nullPct < 40 ? 'var(--amber)' : 'var(--red)')
        : 'var(--text-muted)';
      const distinctVal = d.distinctCount !== null && d.distinctCount !== undefined ? d.distinctCount.toLocaleString() : '\u2014';
      const domainVal = d.hasDomain ? '\u2713' : '\u2014';
      const domainColor = d.hasDomain ? 'var(--purple)' : 'var(--text-muted)';

      // [Placeholder Detection]
      let qualityHtml = '\u2014';
      const qWarnings = [];
      if (typeof d.emptyPct === 'number' && d.emptyPct > 5) {
        qWarnings.push(`<span class="field-stat-placeholder">${d.emptyPct.toFixed(0)}% empty</span>`);
      }
      if (typeof d.dominantPct === 'number' && d.dominantPct >= 90 && d.dominantValue !== null && d.dominantValue !== undefined) {
        const dv = String(d.dominantValue);
        const trunc = dv.length > 15 ? dv.slice(0, 12) + '\u2026' : dv;
        qWarnings.push(`<span class="field-stat-placeholder">${d.dominantPct.toFixed(0)}% \u201c${escapeHtml(trunc)}\u201d</span>`);
      }
      if (qWarnings.length) qualityHtml = qWarnings.join(' ');
      else if (d.nullPct !== null) qualityHtml = '<span class="field-stat-ok">\u2713</span>';
      // [/Placeholder Detection]

      html += `
        <tr>
          <td><button type="button" class="link-button" data-dataset-id="${escapeHtml(d.datasetId)}" title="${escapeHtml(d.datasetTitle)}">${escapeHtml(
            d.datasetTitle.length > 45 ? d.datasetTitle.slice(0, 42) + '\u2026' : d.datasetTitle
          )}</button></td>
          <td><span class="field-type-badge field-type-badge-sm" style="background:${tc}">${escapeHtml(st)}</span></td>
          <td style="color:var(--text-muted);font-size:0.82rem;">${escapeHtml(d.alias)}</td>
          <td style="color:${nullColor};font-weight:600;">${nullVal}</td>
          <td style="font-variant-numeric:tabular-nums;">${distinctVal}</td>
          <td class="fields-stat-col">${qualityHtml}</td>
          <td style="color:${domainColor};text-align:center;">${domainVal}</td>
        </tr>`;
    });

    html += `
        </tbody>
      </table>
      </div>`;
  } else {
    html += '<p style="color:var(--text-muted);">No datasets found.</p>';
  }

  html += '</div>'; // end datasets card

  els.attributeDetailEl.innerHTML = html;
  els.attributeDetailEl.classList.remove('hidden');

  // Wire dataset links
  els.attributeDetailEl.querySelectorAll('button[data-dataset-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dsId = btn.getAttribute('data-dataset-id');
      showDatasetsView();
      state.lastSelectedDatasetId = dsId;
      renderDatasetDetail(dsId);
    });
  });
}

function _renderLegacyAttributeDetail(attribute) {
   // highlight active attribute in sidebar (if list is rendered)
   setActiveListButton(els.attributeListEl, (b) => b.getAttribute('data-attr-id') === attribute.id);

    const datasets = getDatasetsForAttribute(attribute.id);

    let html = '';

    html += `<h2>${escapeHtml(attribute.id)} – ${escapeHtml(attribute.label || '')}</h2>`;
    html += '<div class="card card-attribute-meta">';
    html += `<p><strong>Attribute Field Name:</strong> ${escapeHtml(attribute.id)}</p>`;
    html += `<p><strong>Attribute Label:</strong> ${escapeHtml(attribute.label || '')}</p>`;
    html += `<p><strong>Attribute Type:</strong> ${escapeHtml(attribute.type || '')}</p>`;
    html += `<p><strong>Attribute Definition:</strong> ${escapeHtml(attribute.definition || '')}</p>`;
    if (attribute.expected_value !== undefined) {
      html += `<p><strong>Example Expected Value:</strong> ${escapeHtml(String(attribute.expected_value))}</p>`;
    }
    html += '</div>';

    if (attribute.type === 'enumerated' && Array.isArray(attribute.values) && attribute.values.length) {
      html += '<div class="card card-enumerated">';
      html += '<h3>Allowed values</h3>';
      html += `
        <table>
          <thead>
            <tr><th>Code</th><th>Label</th><th>Description</th></tr>
          </thead>
          <tbody>
      `;
      attribute.values.forEach((v) => {
        const code = v.code !== undefined ? String(v.code) : '';
        const label = v.label || '';
        const desc = v.description || '';
        html += `
          <tr>
            <td>${escapeHtml(code)}</td>
            <td>${escapeHtml(label)}</td>
            <td>${escapeHtml(desc)}</td>
          </tr>
        `;
      });
      html += `
          </tbody>
        </table>
      `;
      html += '</div>';
    }

    html += '<div class="card card-attribute-datasets">';
    html += '<h3>Datasets using this attribute</h3>';
    if (!datasets.length) {
      html += '<p>No datasets currently reference this attribute.</p>';
    } else {
      html += '<ul>';
      datasets.forEach((ds) => {
        html += `
          <li>
            <button type="button" class="link-button" data-dataset-id="${escapeHtml(ds.id)}">
              ${escapeHtml(ds.title || ds.id)}
            </button>
          </li>`;
      });
      html += '</ul>';
    }
    html += '</div>';

    html += `
  <div class="card card-actions">
    <button type="button" class="suggest-button" data-edit-attribute="${escapeHtml(attribute.id)}">
      Suggest a change to this attribute
    </button>
  </div>
`;


    els.attributeDetailEl.innerHTML = html;
    els.attributeDetailEl.classList.remove('hidden');

    const editAttrBtn = els.attributeDetailEl.querySelector('button[data-edit-attribute]');
    if (editAttrBtn) {
      editAttrBtn.addEventListener('click', () => {
        const id = editAttrBtn.getAttribute('data-edit-attribute');
        enterAttributeEditMode(id, () => renderAttributeDetail(id));
      });
    }
    const rootBtn = els.attributeDetailEl.querySelector('button[data-breadcrumb="attributes"]');
    if (rootBtn) rootBtn.addEventListener('click', showAttributesView);

    const dsButtons = els.attributeDetailEl.querySelectorAll('button[data-dataset-id]');
    dsButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const dsId = btn.getAttribute('data-dataset-id');
        showDatasetsView();
        // keep lastSelectedDatasetId in sync on navigation
        state.lastSelectedDatasetId = dsId;
        renderDatasetDetail(dsId);
      });
    });
  }
