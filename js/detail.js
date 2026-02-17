import { state, els } from './state.js';
import { escapeHtml } from './utils.js';
import { getGeometryIconHTML } from './geometry-icons.js';
import { setActiveListButton } from './ui-fx.js';
import { runUrlChecks } from './url-check.js';
import { normalizeServiceUrl, parseServiceAndLayerId, maybeRenderPublicServicePreviewCard, incrementRenderGeneration, getCurrentMapView, setCurrentMapView } from './arcgis-preview.js';
import { renderCoverageMapCard, getCoverageCache } from './coverage-map.js';
import { getDatasetById, getAttributeById, getAttributesForDataset, getDatasetsForAttribute } from './catalog.js';
import { showDatasetsView, showAttributesView } from './navigation.js';
import { enterDatasetEditMode, enterAttributeEditMode } from './edit-mode.js';
import { applyDashboardFilter } from './filters.js';
import { maturityCardHTML, initMaturityCard } from './maturity-card.js';

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

    const geomIconHtml = getGeometryIconHTML(dataset.geometry_type || '', 'geom-icon-inline');
    const attrs = getAttributesForDataset(dataset);

    let html = '';

    html += `<h2>${escapeHtml(dataset.title || dataset.id)}</h2>`;
    if (dataset.description) html += `<p>${escapeHtml(dataset.description)}</p>`;

    // Data source legend (dev helper)
    html += `
      <div class="card" style="padding:0.6rem 0.85rem; margin-bottom:0.5rem; background:rgba(255,255,255,0.02);">
        <div style="font-size:0.8rem; color:var(--text-muted); display:flex; flex-wrap:wrap; gap:1rem; align-items:center;">
          <strong style="color:var(--text-main);">Data Source Legend:</strong>
          <span><span class="data-source-badge data-source-badge-manual">Manual</span> Entered in catalog.json</span>
          <span><span class="data-source-badge data-source-badge-auto">Auto</span> Fetched from ArcGIS REST API</span>
          <span><span class="data-source-badge data-source-badge-hybrid">Hybrid</span> Links manual to auto-detected</span>
        </div>
      </div>
    `;

    html += '<div class="card card-meta">';
    html += '<div class="card-header-row"><h3>Dataset Information</h3><span class="data-source-badge data-source-badge-manual">Manual</span></div>';
    
    // === Catalog Metadata Section ===
    html += '<div class="manual-section">';
    html += '<h4 class="manual-section-title">Catalog Metadata</h4>';
    html += `<p><strong>Geometry Type:</strong> ${geomIconHtml}${escapeHtml(dataset.geometry_type || '')}</p>`;
    html += `<p><strong>Agency Owner:</strong> ${escapeHtml(dataset.agency_owner || '')}</p>`;
    html += `<p><strong>Office Owner:</strong> ${escapeHtml(dataset.office_owner || '')}</p>`;
    html += `<p><strong>Contact Email:</strong> ${escapeHtml(dataset.contact_email || '')}</p>`;

    html += `<p><strong>Topics:</strong> ${Array.isArray(dataset.topics)
      ? dataset.topics.map((t) => `<button type="button" class="pill pill-topic pill-clickable" data-topic-filter="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join(' ')
      : ''
      }</p>`;

    html += `<p><strong>Update Frequency:</strong> ${escapeHtml(dataset.update_frequency || '')}</p>`;
    html += `<p><strong>Access Level:</strong> ${escapeHtml(dataset.access_level || '')}</p>`;

 html += `<p class="url-check-row" data-url-check-row data-url="${escapeHtml(dataset.public_web_service || '')}" data-url-status="idle">
   <strong>Public Web Service:</strong>
   <span class="url-status-icon" aria-hidden="true"></span>
   ${dataset.public_web_service
     ? `<a href="${dataset.public_web_service}" target="_blank" rel="noopener">${escapeHtml(dataset.public_web_service)}</a>`
     : ''
   }
 </p>`;

 html += `<p class="url-check-row" data-url-check-row data-url="${escapeHtml(dataset.internal_web_service || '')}" data-url-status="idle">
   <strong>Internal Web Service:</strong>
   <span class="url-status-icon" aria-hidden="true"></span>
   ${dataset.internal_web_service
     ? `<a href="${dataset.internal_web_service}" target="_blank" rel="noopener">${escapeHtml(dataset.internal_web_service)}</a>`
     : ''
   }
 </p>`;

 if (dataset.data_standard) {
   const dsVal = dataset.data_standard;
   const isUrl = /^https?:\/\//i.test(dsVal);
   if (isUrl) {
     html += `<p class="url-check-row" data-url-check-row data-url="${escapeHtml(dsVal)}" data-url-status="idle">
       <strong>Data Standard:</strong>
       <span class="url-status-icon" aria-hidden="true"></span>
       <a href="${escapeHtml(dsVal)}" target="_blank" rel="noopener">${escapeHtml(dsVal)}</a>
     </p>`;
   } else {
     html += `<p><strong>Data Standard:</strong> ${escapeHtml(dsVal)}</p>`;
   }
 }

    if (dataset.notes) html += `<p><strong>Notes:</strong> ${escapeHtml(dataset.notes)}</p>`;
    html += '</div>'; // end Catalog Metadata section

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
    
    html += `<p><strong>Development Stage:</strong> <span class="stage-badge ${stageInfo.class}">${escapeHtml(stageInfo.label)}</span></p>`;
    
    if (dataset.target_release_date) {
      html += `<p><strong>Target Release Date:</strong> ${escapeHtml(dataset.target_release_date)}</p>`;
    }
    
    if (Array.isArray(dataset.blockers) && dataset.blockers.length) {
      html += `<p><strong>Blockers:</strong></p><ul>`;
      dataset.blockers.forEach(b => { html += `<li>${escapeHtml(b)}</li>`; });
      html += `</ul>`;
    }
    html += '</div>'; // end Development & Status section

    // Edit button at bottom of manual card
    html += `
      <div class="manual-section-actions">
        <button type="button" class="suggest-button" data-edit-dataset="${escapeHtml(dataset.id)}">
          Edit
        </button>
      </div>
    `;

    html += '</div>'; // end combined manual card

    // Auto-computed Data Maturity card (initialized after innerHTML is set)
    html += maturityCardHTML();

    // Coverage Map card (populated asynchronously by renderCoverageMapCard)
    html += '<div class="card card-coverage" id="coverageMapCard" style="border-left:4px solid #4CAF50;">';
    html += '<div class="card-header-row"><h3>\uD83D\uDDFA\uFE0F Coverage Map</h3><div style="display:flex;align-items:center;gap:0.5rem;"><span class="data-source-badge data-source-badge-auto">Auto</span><button type="button" class="btn" data-cov-refresh title="Re-run live coverage analysis" style="padding:0.25rem 0.6rem;font-size:0.78rem;">&#x21bb; Refresh</button></div></div>';
    html += '<p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">Spatial intersection with <a href="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0" target="_blank" rel="noopener">Census Bureau TIGER state boundaries</a>. A 2 km inward buffer is applied to each state boundary to exclude sliver intersections along shared borders. Counts are approximate.</p>';
    html += '<div data-cov-status class="coverage-status">Waiting for analysis\u2026</div>';
    html += '<div data-cov-content></div>';
    html += '</div>';

    // Attributes + inline attribute details - only show if dataset has attributes
    if (attrs.length > 0) {
      html += `
        <div class="card-row">
          <div class="card card-attributes">
            <div class="card-header-row"><h3>Attributes</h3><span class="data-source-badge data-source-badge-hybrid">Hybrid</span></div>
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
    <div class="card-header-row"><h3>Public Web Service Preview</h3><span class="data-source-badge data-source-badge-auto">Auto</span></div>
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

// Check URL status icons (async)
runUrlChecks(els.datasetDetailEl);

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

    const editBtn = els.datasetDetailEl.querySelector('button[data-edit-dataset]');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const dsId = editBtn.getAttribute('data-edit-dataset');
        enterDatasetEditMode(dsId, () => renderDatasetDetail(dsId));
      });
    }
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

export function renderAttributeDetail(attrId) {
    if (!els.attributeDetailEl) return;

  // Browsing existing attributes should not animate.
  // Also make sure no prior FX classes linger from edit/create flows.
  els.attributeDetailEl.classList.remove('fx-enter', 'fx-animating');

   // highlight active attribute in sidebar (if list is rendered)
   setActiveListButton(els.attributeListEl, (b) => b.getAttribute('data-attr-id') === attrId);

    const attribute = getAttributeById(attrId);
    if (!attribute) {
      els.attributeDetailEl.classList.remove('hidden');
      els.attributeDetailEl.innerHTML = `<p>Attribute not found: ${escapeHtml(attrId)}</p>`;
      return;
    }

    const datasets = getDatasetsForAttribute(attrId);

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
