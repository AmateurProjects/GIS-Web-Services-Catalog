// new-dataset-form.js — Simplified new dataset request form (3 fields only).
// Users typically don't know technical details about datasets that don't exist yet.
// They just need to say *what* they want and *why*.

import { els } from './state.js';
import { escapeHtml } from './utils.js';
import { animatePanel, staggerCards } from './ui-fx.js';
import { showDatasetsView, goBackToLastDatasetOrList } from './navigation.js';
import { buildNewDatasetRequestUrl, fetchPendingDatasetRequests, parseRequestedDatasetName, parseRequestedDescription } from './github-api.js';

/**
 * Render the minimal new-dataset request form into the dataset detail panel.
 * Fields: Name, Description, Justification — that's it.
 * Also shows any currently-pending requests so users can avoid duplicates.
 */
export function renderNewDatasetRequestForm() {
  if (!els.datasetDetailEl) return;

  let html = '';

  // Breadcrumb
  html += `
    <nav class="breadcrumb">
      <button type="button" class="breadcrumb-root" data-breadcrumb="datasets">Datasets</button>
      <span class="breadcrumb-separator">/</span>
      <span class="breadcrumb-current">Request new dataset</span>
    </nav>
  `;

  html += `<h2>Request a new dataset</h2>`;
  html += `<p class="modal-help">Describe what dataset you need and why. A catalog maintainer will review your request and add the dataset if approved.</p>`;

  // ── Form card ──
  html += `<div class="card card-meta">`;
  html += `
    <div class="dataset-edit-actions">
      <button type="button" class="btn" data-req-cancel>Cancel</button>
      <button type="button" class="btn primary" data-req-submit>Submit request</button>
    </div>
  `;

  html += `
    <div class="dataset-edit-row">
      <label class="dataset-edit-label">Dataset Name <span class="required-star">*</span></label>
      <input class="dataset-edit-input" type="text" data-req-field="name"
             placeholder="e.g., BLM Grazing Allotments" />
    </div>
    <div class="dataset-edit-row">
      <label class="dataset-edit-label">Description <span class="required-star">*</span></label>
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
          <label class="dataset-edit-label">Existing link or source (if known)</label>
          <input class="dataset-edit-input" type="text" data-req-field="existing_link"
                 placeholder="e.g., a URL, ArcGIS Online page, or document name" />
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

  // ── Wire breadcrumb ──
  const rootBtn = els.datasetDetailEl.querySelector('button[data-breadcrumb="datasets"]');
  if (rootBtn) rootBtn.addEventListener('click', showDatasetsView);

  // ── Wire cancel ──
  const cancelBtn = els.datasetDetailEl.querySelector('button[data-req-cancel]');
  if (cancelBtn) cancelBtn.addEventListener('click', goBackToLastDatasetOrList);

  // ── Wire submit ──
  const submitBtn = els.datasetDetailEl.querySelector('button[data-req-submit]');
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      const getVal = (key) => String(els.datasetDetailEl.querySelector(`[data-req-field="${key}"]`)?.value || '').trim();

      const name = getVal('name');
      const description = getVal('description');
      const justification = getVal('justification');

      // Optional properties
      const properties = {
        topics: getVal('topics'),
        geometry_type: getVal('geometry_type'),
        coverage: getVal('coverage'),
        agency_owner: getVal('agency_owner'),
        update_frequency: getVal('update_frequency'),
        access_level: getVal('access_level'),
        existing_link: getVal('existing_link'),
        additional_notes: getVal('additional_notes'),
      };

      if (!name) {
        alert('Dataset name is required.');
        return;
      }
      if (!description) {
        alert('A brief description is required.');
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
