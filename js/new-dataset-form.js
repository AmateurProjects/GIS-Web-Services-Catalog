// new-dataset-form.js — Simplified new dataset request form (3 fields only).
// Users typically don't know technical details about datasets that don't exist yet.
// They just need to say *what* they want and *why*.

import { els } from './state.js';
import { escapeHtml } from './utils.js';
import { animatePanel, staggerCards } from './ui-fx.js';
import { showDatasetsView, goBackToLastDatasetOrList } from './navigation.js';
import { buildNewDatasetRequestUrl, fetchPendingDatasetRequests, parseRequestedDatasetName } from './github-api.js';

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

      if (!name) {
        alert('Dataset name is required.');
        return;
      }
      if (!description) {
        alert('A brief description is required.');
        return;
      }

      const issueUrl = buildNewDatasetRequestUrl({ name, description, justification });

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
      const date = req.created_at ? new Date(req.created_at).toLocaleDateString() : '';
      const user = req.user || '';
      html += `
        <li class="pending-request-item">
          <a href="${escapeHtml(req.url)}" target="_blank" rel="noopener" class="pending-request-link">
            <strong>${escapeHtml(name)}</strong>
            <span class="pending-request-meta">#${req.number}${user ? ` by ${escapeHtml(user)}` : ''}${date ? ` · ${date}` : ''}</span>
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
