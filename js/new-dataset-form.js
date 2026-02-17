// new-dataset-form.js — New dataset / web service request form.
// Supports two workflows:
//   1. Paste an existing ArcGIS REST URL → auto-analyze & pre-fill fields
//   2. Describe a dataset you need → fill in name + description manually

import { els } from './state.js';
import { escapeHtml } from './utils.js';
import { animatePanel, staggerCards } from './ui-fx.js';
import { goBackToLastDatasetOrList } from './navigation.js';
import { buildNewDatasetRequestUrl, fetchPendingDatasetRequests, parseRequestedDatasetName, parseRequestedDescription } from './github-api.js';
import { looksLikeArcGisService, normalizeServiceUrl, parseServiceAndLayerId, fetchServiceJson, fetchLayerJson } from './arcgis-preview.js';

/**
 * Render the minimal new-dataset request form into the dataset detail panel.
 * Fields: Name, Description, Justification — that's it.
 * Also shows any currently-pending requests so users can avoid duplicates.
 */
export function renderNewDatasetRequestForm() {
  if (!els.datasetDetailEl) return;

  let html = '';

  html += `<h2>Submit a new dataset</h2>`;
  html += `<p class="modal-help">Paste a web service URL to auto-detect service details, or describe the dataset you need. A catalog maintainer will review your submission.</p>`;

  // ── Form card ──
  html += `<div class="card card-meta">`;
  html += `
    <div class="dataset-edit-actions">
      <button type="button" class="btn" data-req-cancel>Cancel</button>
      <button type="button" class="btn primary" data-req-submit>Submit request</button>
    </div>
  `;

  // Web Service URL (prominent, first)
  html += `
    <div class="dataset-edit-row">
      <label class="dataset-edit-label">Web Service URL</label>
      <div style="display:flex;gap:0.5rem;align-items:flex-start;">
        <input class="dataset-edit-input" type="text" data-req-field="service_url" style="flex:1;"
               placeholder="e.g., https://gis.blm.gov/arcgis/rest/services/.../FeatureServer/0" />
        <button type="button" class="btn" data-analyze-btn style="white-space:nowrap;">Analyze</button>
      </div>
      <p class="text-muted" style="font-size:0.78rem;margin-top:0.25rem;">Paste an ArcGIS REST service URL and click Analyze to auto-fill details below.</p>
    </div>
  `;

  // Service analysis preview area (initially hidden)
  html += `<div data-service-preview style="display:none;"></div>`;

  html += `
    <div class="dataset-edit-row">
      <label class="dataset-edit-label">Dataset Name <span class="required-star">*</span></label>
      <input class="dataset-edit-input" type="text" data-req-field="name"
             placeholder="e.g., BLM Grazing Allotments" />
    </div>
    <div class="dataset-edit-row">
      <label class="dataset-edit-label">Description</label>
      <textarea class="dataset-edit-input" data-req-field="description" rows="3"
                placeholder="Briefly describe the dataset — what data does it contain?"></textarea>
    </div>
    <div class="dataset-edit-row">
      <label class="dataset-edit-label">Justification / Use Case</label>
      <textarea class="dataset-edit-input" data-req-field="justification" rows="3"
                placeholder="Why do you need this dataset? What project or workflow would it support?"></textarea>
    </div>
  `;
  html += `</div>`;

  // ── Optional properties card ──
  html += `
    <div class="card" id="requestPropertiesCard" style="margin-top:0.75rem;">
      <button type="button" class="collapse-toggle" data-toggle-props aria-expanded="false" style="display:flex;align-items:center;gap:0.4rem;background:none;border:none;cursor:pointer;font-size:1rem;font-weight:600;padding:0;color:var(--text);">
        <span class="collapse-icon" style="transition:transform 0.2s;">&#9654;</span>
        Tell us more <span style="font-weight:400;font-size:0.85rem;color:var(--text-muted);">(optional)</span>
      </button>
      <p class="text-muted" style="margin-top:0.25rem;font-size:0.85rem;">If you know any of these details, they'll help the catalog team set things up faster.</p>
      <div data-props-body style="display:none;margin-top:0.75rem;">
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">Topic Area</label>
          <input class="dataset-edit-input" type="text" data-req-field="topics"
                 placeholder="e.g., Wildlife, Energy, Land Use, Recreation" />
        </div>
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">Data Type</label>
          <select class="dataset-edit-input" data-req-field="geometry_type">
            <option value="">Not sure</option>
            <option value="POINT">Points (locations on a map)</option>
            <option value="POLYLINE">Lines (roads, trails, boundaries)</option>
            <option value="POLYGON">Areas / Shapes (parcels, regions)</option>
            <option value="TABLE">Table only (no map geometry)</option>
          </select>
        </div>
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">Geographic Coverage</label>
          <select class="dataset-edit-input" data-req-field="coverage">
            <option value="">Not sure</option>
            <option value="nationwide">Nationwide</option>
            <option value="multi_state">Multiple states</option>
            <option value="single_state">Single state</option>
            <option value="partial">Partial / limited area</option>
          </select>
        </div>
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">Who manages this data?</label>
          <input class="dataset-edit-input" type="text" data-req-field="agency_owner"
                 placeholder="e.g., BLM, USFS, State agency, Contractor" />
        </div>
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">How often is it updated?</label>
          <select class="dataset-edit-input" data-req-field="update_frequency">
            <option value="">Not sure</option>
            <option value="Real-time">Real-time / Near real-time</option>
            <option value="Daily">Daily</option>
            <option value="Weekly">Weekly</option>
            <option value="Monthly">Monthly</option>
            <option value="Quarterly">Quarterly</option>
            <option value="Annually">Annually</option>
            <option value="Ad hoc">Ad hoc / As needed</option>
          </select>
        </div>
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">Who should have access?</label>
          <select class="dataset-edit-input" data-req-field="access_level">
            <option value="">Not sure</option>
            <option value="Public">Public (anyone can view)</option>
            <option value="Internal">Internal (agency staff only)</option>
          </select>
        </div>
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">Anything else?</label>
          <textarea class="dataset-edit-input" data-req-field="additional_notes" rows="2"
                    placeholder="Any other details — contacts, known issues, related datasets, etc."></textarea>
        </div>
      </div>
    </div>
  `;

  // ── Pending requests card (loads async) ──
  html += `
    <div class="card" id="pendingRequestsCard">
      <h3>Pending dataset requests</h3>
      <p class="text-muted" style="margin-top:0.25rem;font-size:0.85rem;">
        Check below to make sure your request hasn't already been submitted.
      </p>
      <div data-pending-list>
        <p class="loading-message">Loading pending requests&hellip;</p>
      </div>
    </div>
  `;

  els.datasetDetailEl.innerHTML = html;
  els.datasetDetailEl.classList.remove('hidden');

  staggerCards(els.datasetDetailEl);
  animatePanel(els.datasetDetailEl);

  // ── Wire collapsible properties section ──
  const toggleBtn = els.datasetDetailEl.querySelector('[data-toggle-props]');
  const propsBody = els.datasetDetailEl.querySelector('[data-props-body]');
  if (toggleBtn && propsBody) {
    toggleBtn.addEventListener('click', () => {
      const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.setAttribute('aria-expanded', String(!expanded));
      propsBody.style.display = expanded ? 'none' : 'block';
      const icon = toggleBtn.querySelector('.collapse-icon');
      if (icon) icon.style.transform = expanded ? '' : 'rotate(90deg)';
    });
  }

  // ── Wire Analyze button ──
  const analyzeBtn = els.datasetDetailEl.querySelector('[data-analyze-btn]');
  const serviceUrlInput = els.datasetDetailEl.querySelector('[data-req-field="service_url"]');
  const previewArea = els.datasetDetailEl.querySelector('[data-service-preview]');

  if (analyzeBtn && serviceUrlInput) {
    analyzeBtn.addEventListener('click', () => analyzeServiceUrl());
    // Also trigger on paste (slight delay for value to be set)
    serviceUrlInput.addEventListener('paste', () => setTimeout(() => analyzeServiceUrl(), 150));
  }

  async function analyzeServiceUrl() {
    const url = serviceUrlInput?.value?.trim();
    if (!url) return;
    if (!looksLikeArcGisService(url)) {
      if (previewArea) {
        previewArea.style.display = 'block';
        previewArea.innerHTML = `<div class="card" style="margin:0.5rem 0;padding:0.75rem;border-color:var(--amber);"><p style="color:var(--amber);font-size:0.85rem;margin:0;">⚠ This doesn't look like an ArcGIS REST service URL. Expected a URL containing <code>/rest/services/</code> and ending in <code>/FeatureServer</code>, <code>/MapServer</code>, or <code>/ImageServer</code>.</p><p class="text-muted" style="font-size:0.8rem;margin:0.4rem 0 0;">You can still submit the form — the URL will be included in the request.</p></div>`;
      }
      return;
    }

    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing…';
    if (previewArea) {
      previewArea.style.display = 'block';
      previewArea.innerHTML = '<p class="loading-message" style="font-size:0.85rem;margin:0.5rem 0;">Fetching service info…</p>';
    }

    try {
      const normalized = normalizeServiceUrl(url);
      const parsed = parseServiceAndLayerId(normalized);
      const serviceJson = await fetchServiceJson(parsed.serviceUrl);

      // Determine target layer
      let layerJson = null;
      let layerId = parsed.layerId;

      if (layerId !== null) {
        layerJson = await fetchLayerJson(parsed.serviceUrl, layerId);
      } else if (serviceJson.layers && serviceJson.layers.length === 1) {
        layerId = serviceJson.layers[0].id;
        layerJson = await fetchLayerJson(parsed.serviceUrl, layerId);
      } else if (serviceJson.layers && serviceJson.layers.length > 0) {
        layerId = serviceJson.layers[0].id;
        layerJson = await fetchLayerJson(parsed.serviceUrl, layerId);
      }

      // Extract useful info
      const docInfo = serviceJson.documentInfo || {};
      const serviceName = layerJson?.name || serviceJson.mapName || docInfo.Title || '';
      const serviceDesc = layerJson?.description || serviceJson.serviceDescription || serviceJson.description || '';
      const geomType = layerJson?.geometryType || '';
      const fieldCount = layerJson?.fields?.length || 0;
      const capabilities = serviceJson.capabilities || '';
      const version = serviceJson.currentVersion || '';
      const featureCount = layerJson?.featureCount ?? null;
      const spatialRef = layerJson?.spatialReference || serviceJson.spatialReference || {};
      const layerCount = (serviceJson.layers || []).length;

      // Map esri geometry types to our form values
      const geomMap = {
        esriGeometryPoint: 'POINT',
        esriGeometryMultipoint: 'POINT',
        esriGeometryPolyline: 'POLYLINE',
        esriGeometryPolygon: 'POLYGON',
      };

      // Pre-fill form fields
      const nameInput = els.datasetDetailEl.querySelector('[data-req-field="name"]');
      const descInput = els.datasetDetailEl.querySelector('[data-req-field="description"]');
      const geomSelect = els.datasetDetailEl.querySelector('[data-req-field="geometry_type"]');

      if (nameInput && !nameInput.value && serviceName) {
        nameInput.value = serviceName.replace(/_/g, ' ');
      }
      if (descInput && !descInput.value && serviceDesc) {
        // Strip HTML tags from service description
        const cleanDesc = serviceDesc.replace(/<[^>]*>/g, '').trim();
        if (cleanDesc) descInput.value = cleanDesc;
      }
      if (geomSelect && geomType && geomMap[geomType]) {
        geomSelect.value = geomMap[geomType];
      }
      if (!geomType) {
        // Might be a table
        if (geomSelect) geomSelect.value = 'TABLE';
      }

      // Auto-expand optional properties so the user sees the auto-filled geometry
      const propsToggle = els.datasetDetailEl.querySelector('[data-toggle-props]');
      const propsBodyEl = els.datasetDetailEl.querySelector('[data-props-body]');
      if (propsToggle && propsBodyEl && propsToggle.getAttribute('aria-expanded') !== 'true') {
        propsToggle.setAttribute('aria-expanded', 'true');
        propsBodyEl.style.display = 'block';
        const icon = propsToggle.querySelector('.collapse-icon');
        if (icon) icon.style.transform = 'rotate(90deg)';
      }

      // Show analysis preview
      if (previewArea) {
        const geomLabel = geomType ? geomType.replace('esriGeometry', '') : 'Table / Non-spatial';
        const wkid = spatialRef.latestWkid || spatialRef.wkid || '';
        let previewHtml = `<div class="card" style="margin:0.5rem 0;padding:0.75rem;border-color:var(--green);">`;
        previewHtml += `<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;"><span style="color:var(--green);font-size:1.1rem;">✓</span><strong style="font-size:0.9rem;">Service Detected</strong></div>`;
        previewHtml += `<div class="metadata-grid" style="font-size:0.82rem;">`;
        if (serviceName) previewHtml += `<div class="metadata-item"><span class="metadata-label">Name</span><span class="metadata-value">${escapeHtml(serviceName)}</span></div>`;
        previewHtml += `<div class="metadata-item"><span class="metadata-label">Type</span><span class="metadata-value">${escapeHtml(geomLabel)}</span></div>`;
        if (fieldCount) previewHtml += `<div class="metadata-item"><span class="metadata-label">Fields</span><span class="metadata-value">${fieldCount}</span></div>`;
        if (featureCount !== null) previewHtml += `<div class="metadata-item"><span class="metadata-label">Features</span><span class="metadata-value">${Number(featureCount).toLocaleString()}</span></div>`;
        if (layerCount > 1) previewHtml += `<div class="metadata-item"><span class="metadata-label">Layers</span><span class="metadata-value">${layerCount}</span></div>`;
        if (version) previewHtml += `<div class="metadata-item"><span class="metadata-label">Version</span><span class="metadata-value">${version}</span></div>`;
        if (wkid) previewHtml += `<div class="metadata-item"><span class="metadata-label">Spatial Ref</span><span class="metadata-value">EPSG:${wkid}</span></div>`;
        if (capabilities) previewHtml += `<div class="metadata-item"><span class="metadata-label">Capabilities</span><span class="metadata-value">${escapeHtml(capabilities)}</span></div>`;
        previewHtml += `</div></div>`;
        previewArea.innerHTML = previewHtml;
      }
    } catch (err) {
      console.warn('Service analysis failed:', err);
      if (previewArea) {
        previewArea.innerHTML = `<div class="card" style="margin:0.5rem 0;padding:0.75rem;border-color:var(--red);"><p style="color:var(--red);font-size:0.85rem;margin:0;">✗ Could not analyze this service. ${escapeHtml(err.message || 'The URL may be unreachable or require authentication.')}</p><p class="text-muted" style="font-size:0.8rem;margin:0.4rem 0 0;">You can still submit the form — the URL will be included in the request for manual review.</p></div>`;
      }
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'Analyze';
    }
  }

  // ── Wire cancel ──
  const cancelBtn = els.datasetDetailEl.querySelector('button[data-req-cancel]');
  if (cancelBtn) cancelBtn.addEventListener('click', goBackToLastDatasetOrList);

  // ── Wire submit ──
  const submitBtn = els.datasetDetailEl.querySelector('button[data-req-submit]');
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      const getVal = (key) => String(els.datasetDetailEl.querySelector(`[data-req-field="${key}"]`)?.value || '').trim();

      const serviceUrl = getVal('service_url');
      const name = getVal('name');
      const description = getVal('description');
      const justification = getVal('justification');

      // Optional properties
      const properties = {
        service_url: serviceUrl,
        topics: getVal('topics'),
        geometry_type: getVal('geometry_type'),
        coverage: getVal('coverage'),
        agency_owner: getVal('agency_owner'),
        update_frequency: getVal('update_frequency'),
        access_level: getVal('access_level'),
        additional_notes: getVal('additional_notes'),
      };

      if (!name) {
        alert('Dataset name is required.');
        return;
      }

      const issueUrl = buildNewDatasetRequestUrl({ name, description, justification, properties });

      // Return to normal view
      goBackToLastDatasetOrList();

      const w = window.open(issueUrl, '_blank', 'noopener');
      if (!w) alert('Popup blocked — please allow popups to open the GitHub Issue.');
    });
  }

  // ── Load pending requests async ──
  loadPendingRequests();
}

/** Fetch and render pending dataset requests into the form. */
async function loadPendingRequests() {
  const listEl = els.datasetDetailEl?.querySelector('[data-pending-list]');
  if (!listEl) return;

  try {
    const requests = await fetchPendingDatasetRequests();

    if (!requests || !requests.length) {
      listEl.innerHTML = '<p class="text-muted">No pending requests found.</p>';
      return;
    }

    let html = `<ul class="pending-requests-list">`;
    requests.forEach(req => {
      const name = parseRequestedDatasetName(req.title);
      const desc = parseRequestedDescription(req.body);
      const date = req.created_at ? new Date(req.created_at).toLocaleDateString() : '';
      const user = req.user || '';
      html += `
        <li class="pending-request-item">
          <a href="${escapeHtml(req.url)}" target="_blank" rel="noopener" class="pending-request-link">
            <strong>${escapeHtml(name)}</strong>
            ${desc ? `<span class="pending-request-desc">${escapeHtml(desc)}</span>` : ''}
            <span class="pending-request-meta">${user ? `by ${escapeHtml(user)}` : ''}${user && date ? ` \u00b7 ` : ''}${date || ''}</span>
          </a>
        </li>
      `;
    });
    html += `</ul>`;
    listEl.innerHTML = html;
  } catch (err) {
    console.warn('Failed to load pending requests', err);
    listEl.innerHTML = '<p class="text-muted">Could not load pending requests.</p>';
  }
}
