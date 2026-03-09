// edit-mode.js — Inline click-to-edit for dataset detail pages.
// Each field value is always clickable — no separate "edit mode" step.
// Click a value → inline input appears with ✓/✕. Save button appears when changes exist.
// Save → PATCH to Cloudflare Worker → R2 overlay → immediate effect.

import { els } from './state.js';
import { escapeHtml, deepClone, parseCsvList, compactObject, computeChanges, tryParseJson } from './utils.js';
import { getDatasetById, getAttributeById, getDatasetsForAttribute, applyLocalOverrides, removeLocalDataset } from './catalog.js';
import { WORKER_BASE_URL } from './config.js';
import { buildGithubIssueUrlForEditedAttribute } from './github-issues.js';

// ── Field definitions ──

export const DATASET_EDIT_FIELDS = [
  // Catalog Metadata
  { key: 'title', label: 'Dataset Name', type: 'text', section: 'catalog' },
  { key: 'description', label: 'Description', type: 'textarea', section: 'catalog' },
  { key: 'agency_owner', label: 'Agency Owner', type: 'text', section: 'catalog' },
  { key: 'office_owner', label: 'Office Owner', type: 'text', section: 'catalog' },
  { key: 'contact_email', label: 'Contact Email', type: 'text', section: 'catalog' },
  { key: 'topics', label: 'Topics', type: 'csv', section: 'catalog' },
  { key: 'update_frequency', label: 'Update Frequency', type: 'text', section: 'catalog' },
  { key: 'notes', label: 'Notes', type: 'textarea', section: 'catalog' },

  // Data Access
  { key: 'public_web_service', label: 'Public Web Service', type: 'text', section: 'dataaccess' },
  { key: 'internal_web_service', label: 'Internal Web Service', type: 'text', section: 'dataaccess' },
  { key: 'data_standard', label: 'Data Standard', type: 'text', section: 'dataaccess' },
  { key: 'access_level', label: 'Access Level', type: 'text', section: 'dataaccess' },

  // Development & Status
  { key: 'development_stage', label: 'Development Stage', type: 'select', options: ['requested', 'in_development', 'published', 'deprecated'], section: 'devstatus' },
  { key: 'target_release_date', label: 'Target Release Date', type: 'text', section: 'devstatus' },
  { key: 'blockers', label: 'Blockers', type: 'csv', section: 'devstatus' },
  { key: 'improvements', label: 'Improvements Needed', type: 'csv', section: 'devstatus' },

  // Optional
  { key: 'objname', label: 'Database Object Name', type: 'text', section: 'optional' },
];

export const ATTRIBUTE_EDIT_FIELDS = [
  { key: 'label', label: 'Attribute Label', type: 'text' },
  { key: 'type', label: 'Attribute Type', type: 'text' },
  { key: 'definition', label: 'Attribute Definition', type: 'textarea' },
  { key: 'expected_value', label: 'Example Expected Value', type: 'text' },
  { key: 'values', label: 'Allowed values (JSON array)', type: 'json' },
];

// ── GitHub OAuth management ──

function getGithubToken() {
  return sessionStorage.getItem('gis_github_token') || '';
}

function getGithubUser() {
  return sessionStorage.getItem('gis_github_user') || '';
}

function setGithubAuth(token, login) {
  sessionStorage.setItem('gis_github_token', token);
  sessionStorage.setItem('gis_github_user', login);
}

function clearGithubAuth() {
  sessionStorage.removeItem('gis_github_token');
  sessionStorage.removeItem('gis_github_user');
}

function loginWithGithub() {
  return new Promise((resolve, reject) => {
    const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
    if (!workerBase) { reject(new Error('Worker URL not configured.')); return; }

    const popup = window.open(`${workerBase}/auth/github`, 'github-auth', 'width=600,height=700');
    if (!popup) { reject(new Error('Popup blocked. Please allow popups for this site.')); return; }

    function onMessage(event) {
      if (!event.data || event.data.type !== 'github-auth') return;
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        setGithubAuth(event.data.token, event.data.user.login);
        resolve(event.data);
      }
    }
    window.addEventListener('message', onMessage);

    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        window.removeEventListener('message', onMessage);
        if (!getGithubToken()) reject(new Error('Login cancelled.'));
      }
    }, 500);
  });
}

// ── Pending changes tracker ──

let _pendingChanges = {};   // { fieldKey: newValue }
let _originalValues = {};   // { fieldKey: originalValue }
let _activeDatasetId = null;
let _onDoneCallback = null;
let _cardEl = null;          // reference to card element containing save button

function resetPending() {
  _pendingChanges = {};
  _originalValues = {};
  _activeDatasetId = null;
  hideSaveButton();
}

function recordChange(key, newValue, originalValue) {
  // Normalize for comparison
  const normNew = normalizeValue(key, newValue);
  const normOrig = normalizeValue(key, originalValue);

  if (normNew === normOrig) {
    delete _pendingChanges[key];
  } else {
    _pendingChanges[key] = newValue;
  }
  _originalValues[key] = originalValue;
  updateSaveButton();
}

function normalizeValue(key, val) {
  if (val === undefined || val === null || val === '') return '';
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'boolean') return String(val);
  return String(val).trim();
}

function getPendingCount() {
  return Object.keys(_pendingChanges).length;
}

// ── In-card save button management ──

function updateSaveButton() {
  if (!_cardEl) return;
  const area = _cardEl.querySelector('.dataset-save-actions');
  if (!area) return;
  const count = getPendingCount();
  if (count === 0) {
    area.style.display = 'none';
    return;
  }
  area.style.display = 'flex';
  const countEl = area.querySelector('.edit-change-count');
  if (countEl) countEl.textContent = `${count} unsaved change${count !== 1 ? 's' : ''}`;
}

function hideSaveButton() {
  if (!_cardEl) return;
  const area = _cardEl.querySelector('.dataset-save-actions');
  if (area) area.style.display = 'none';
}

// ── Save to Worker ──

async function saveChanges() {
  const count = getPendingCount();
  if (count === 0) return;

  const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
  if (!workerBase) {
    alert('Worker URL not configured. Cannot save edits.');
    return;
  }

  let token = getGithubToken();
  if (!token) {
    try {
      await loginWithGithub();
      token = getGithubToken();
    } catch (e) {
      alert(e.message);
      return;
    }
  }
  if (!token) return;

  const saveBtn = _cardEl?.querySelector('[data-save-edits]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Saving…'; }

  // Build the fields payload — parse types properly
  const fields = {};
  for (const [key, rawValue] of Object.entries(_pendingChanges)) {
    const fieldDef = DATASET_EDIT_FIELDS.find(f => f.key === key);
    if (fieldDef?.type === 'csv') {
      fields[key] = parseCsvList(rawValue);
    } else if (fieldDef?.type === 'boolean') {
      if (rawValue === 'true') fields[key] = true;
      else if (rawValue === 'false') fields[key] = false;
      else fields[key] = null;
    } else {
      fields[key] = rawValue === '' ? null : rawValue;
    }
  }

  async function doPatch(bearerToken) {
    return fetch(`${workerBase}/catalog/dataset/${encodeURIComponent(_activeDatasetId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ fields }),
    });
  }

  try {
    let resp = await doPatch(token);
    let result = await resp.json();

    // On 401 (expired/invalid token), auto re-login and retry once
    if (resp.status === 401 && result.code === 'token_expired') {
      clearGithubAuth();
      try {
        await loginWithGithub();
        token = getGithubToken();
      } catch (e) {
        alert(e.message);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
        return;
      }
      if (!token) { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; } return; }
      resp = await doPatch(token);
      result = await resp.json();
    }

    if (!resp.ok) {
      alert(`Save failed: ${result.error || resp.statusText}`);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
      return;
    }

    // Apply changes locally so UI updates without page reload
    applyLocalOverrides(_activeDatasetId, fields);

    resetPending();
    if (_onDoneCallback) _onDoneCallback();
  } catch (e) {
    alert(`Save failed: ${e.message}`);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
  }
}

// ── Display helpers ──

function displayValue(fieldDef, val) {
  if (val === undefined || val === null || val === '') return '<span style="color:var(--text-muted);font-style:italic;">—</span>';
  if (fieldDef.type === 'csv' && Array.isArray(val)) return escapeHtml(val.join(', '));
  if (fieldDef.type === 'boolean') return val === true ? 'Yes' : val === false ? 'No' : escapeHtml(String(val));
  return escapeHtml(String(val));
}

function renderInlineInput(fieldDef, val) {
  const key = fieldDef.key;
  if (fieldDef.type === 'textarea') {
    return `<textarea class="inline-edit-input" data-inline-key="${escapeHtml(key)}" rows="3">${escapeHtml(val || '')}</textarea>`;
  }
  if (fieldDef.type === 'select' && Array.isArray(fieldDef.options)) {
    const opts = fieldDef.options.map(opt =>
      `<option value="${escapeHtml(opt)}" ${val === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
    return `<select class="inline-edit-input" data-inline-key="${escapeHtml(key)}"><option value="">(select)</option>${opts}</select>`;
  }
  if (fieldDef.type === 'boolean') {
    return `<select class="inline-edit-input" data-inline-key="${escapeHtml(key)}">
      <option value="">(select)</option>
      <option value="true" ${val === true ? 'selected' : ''}>Yes</option>
      <option value="false" ${val === false ? 'selected' : ''}>No</option>
    </select>`;
  }
  if (fieldDef.type === 'csv') {
    const display = Array.isArray(val) ? val.join(', ') : (val || '');
    return `<input class="inline-edit-input" type="text" data-inline-key="${escapeHtml(key)}" value="${escapeHtml(display)}" />`;
  }
  return `<input class="inline-edit-input" type="text" data-inline-key="${escapeHtml(key)}" value="${escapeHtml(val || '')}" />`;
}

// ── Inline field activation ──

function activateField(cell, fieldDef, dataset) {
  if (cell.classList.contains('is-editing')) return;
  // Save original HTML so we can restore on cancel
  cell._savedHTML = cell.innerHTML;
  cell.classList.add('is-editing');

  const val = dataset[fieldDef.key];
  const originalVal = val;

  cell.innerHTML = `
    <div class="inline-edit-wrapper">
      ${renderInlineInput(fieldDef, val)}
      <div class="inline-edit-actions">
        <button type="button" class="inline-edit-ok" title="Confirm">✓</button>
        <button type="button" class="inline-edit-cancel" title="Cancel">✕</button>
      </div>
    </div>
  `;

  const input = cell.querySelector('[data-inline-key]');
  if (input) input.focus();

  // Confirm — record change, show updated value or restore if no actual change
  cell.querySelector('.inline-edit-ok').addEventListener('click', () => {
    const raw = input.value;
    recordChange(fieldDef.key, raw, originalVal);
    const isPending = _pendingChanges.hasOwnProperty(fieldDef.key);
    cell.classList.remove('is-editing');
    if (isPending) {
      // Show updated value as plain text with dirty highlight
      const displayVal = fieldDef.type === 'csv' ? parseCsvList(raw || '').join(', ')
        : fieldDef.type === 'boolean' ? (raw === 'true' ? 'Yes' : raw === 'false' ? 'No' : raw)
        : (raw || '');
      const escaped = displayVal ? escapeHtml(displayVal) : '<span style="color:var(--text-muted);font-style:italic;">—</span>';
      cell.innerHTML = `<span class="inline-edit-value is-dirty">${escaped}</span>`;
    } else {
      // No actual change — restore original HTML
      cell.innerHTML = cell._savedHTML;
    }
    wireFieldClick(cell, fieldDef, dataset);
  });

  // Cancel — restore original HTML
  cell.querySelector('.inline-edit-cancel').addEventListener('click', () => {
    cell.classList.remove('is-editing');
    cell.innerHTML = cell._savedHTML;
    wireFieldClick(cell, fieldDef, dataset);
  });
}

function wireFieldClick(cell, fieldDef, dataset) {
  function handler(e) {
    // Don't activate editing if user clicks a link or button inside the cell
    if (e.target.closest('a') || e.target.closest('button')) return;
    cell.removeEventListener('click', handler);
    activateField(cell, fieldDef, dataset);
  }
  cell.addEventListener('click', handler);
}

// ── Wire dataset inline editing (always-on, no edit mode toggle) ──

/**
 * Wire click-to-edit on all editable fields in the Dataset Information card.
 * Called after the detail page renders. Each field value is immediately clickable.
 * @param {object} dataset - the dataset object
 * @param {function} onDone - callback to re-render detail after save
 */
export function wireDatasetInlineEdit(dataset, onDone) {
  const cardMeta = els.datasetDetailEl?.querySelector('.card.card-meta');
  if (!cardMeta) return;

  resetPending();
  _activeDatasetId = dataset.id;
  _onDoneCallback = onDone;
  _cardEl = cardMeta;

  // Wire click-to-edit on all editable cells
  cardMeta.querySelectorAll('.editable-field[data-field-key]').forEach(cell => {
    const key = cell.getAttribute('data-field-key');
    const fieldDef = DATASET_EDIT_FIELDS.find(f => f.key === key);
    if (fieldDef) wireFieldClick(cell, fieldDef, dataset);
  });

  // Wire save/discard buttons
  const saveBtn = cardMeta.querySelector('[data-save-edits]');
  const discardBtn = cardMeta.querySelector('[data-discard-edits]');
  if (saveBtn) saveBtn.addEventListener('click', () => saveChanges());
  if (discardBtn) discardBtn.addEventListener('click', () => {
    resetPending();
    if (onDone) onDone();
  });
}

// ── Attribute In-Place Edit (kept as GitHub-issue-based for now) ──

/**
 * Enter edit mode for an attribute's detail card.
 * @param {string} attrId
 * @param {function} onDone - callback to re-render attribute detail
 */
export function enterAttributeEditMode(attrId, onDone) {
  const cardMeta = els.attributeDetailEl?.querySelector('.card.card-attribute-meta');
  if (!cardMeta) return;

  const attribute = getAttributeById(attrId);
  if (!attribute) return;

  const original = deepClone(attribute);

  let html = '';

  html += `<div class="edit-mode-actions">
    <button type="button" class="btn" data-edit-cancel>Cancel</button>
    <button type="button" class="btn primary" data-edit-save>Submit change request</button>
  </div>`;

  ATTRIBUTE_EDIT_FIELDS.forEach(f => {
    const val = attribute[f.key];
    let inputHtml;
    if (f.type === 'textarea' || f.type === 'json') {
      const display = f.type === 'json' ? ((val === undefined || val === null) ? '' : JSON.stringify(val, null, 2)) : (val || '');
      inputHtml = `<textarea class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">${escapeHtml(display)}</textarea>`;
    } else {
      inputHtml = `<input class="dataset-edit-input" type="text" data-edit-key="${escapeHtml(f.key)}" value="${escapeHtml(val || '')}" />`;
    }
    html += `<div class="dataset-edit-row">
      <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
      ${inputHtml}
    </div>`;
  });

  cardMeta.innerHTML = html;
  cardMeta.classList.add('is-editing');

  cardMeta.querySelector('[data-edit-cancel]')?.addEventListener('click', () => {
    if (onDone) onDone();
  });

  cardMeta.querySelector('[data-edit-save]')?.addEventListener('click', () => {
    const draft = deepClone(original);
    let hadError = false;

    cardMeta.querySelectorAll('[data-edit-key]').forEach(el => {
      const k = el.getAttribute('data-edit-key');
      const raw = el.value;
      const def = ATTRIBUTE_EDIT_FIELDS.find(x => x.key === k);

      if (def && def.type === 'json') {
        const parsed = tryParseJson(raw);
        if (parsed && parsed.__parse_error__) {
          alert(`JSON parse error:\n${parsed.__parse_error__}`);
          hadError = true;
          return;
        }
        draft[k] = parsed === null ? undefined : parsed;
      } else {
        const s = String(raw || '').trim();
        draft[k] = s === '' ? undefined : s;
      }
    });

    if (hadError) return;

    const updated = compactObject(draft);
    const origCompact = compactObject(original);
    const changes = computeChanges(origCompact, updated);

    if (!changes.length) {
      alert('No changes detected.');
      return;
    }

    const issueUrl = buildGithubIssueUrlForEditedAttribute(attrId, origCompact, updated, changes);
    if (onDone) onDone();
    window.open(issueUrl, '_blank', 'noopener');
  });
}

// ── Delete dataset via Worker ──

/**
 * Delete a dataset by sending DELETE to Worker, then remove from local cache.
 * Requires admin auth (GitHub OAuth). Returns true on success, false on failure.
 * @param {string} datasetId
 */
export async function deleteDataset(datasetId) {
  const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
  if (!workerBase) {
    alert('Worker URL not configured. Cannot delete dataset.');
    return false;
  }

  let token = getGithubToken();
  if (!token) {
    try {
      await loginWithGithub();
      token = getGithubToken();
    } catch (e) {
      alert(e.message);
      return false;
    }
  }
  if (!token) return false;

  async function doDelete(bearerToken) {
    return fetch(`${workerBase}/catalog/dataset/${encodeURIComponent(datasetId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${bearerToken}` },
    });
  }

  try {
    let resp = await doDelete(token);
    let result = await resp.json();

    // On 401 (expired token), auto re-login and retry once
    if (resp.status === 401 && result.code === 'token_expired') {
      clearGithubAuth();
      try {
        await loginWithGithub();
        token = getGithubToken();
      } catch (e) {
        alert(e.message);
        return false;
      }
      if (!token) return false;
      resp = await doDelete(token);
      result = await resp.json();
    }

    if (!resp.ok) {
      alert(`Delete failed: ${result.error || resp.statusText}`);
      return false;
    }

    // Remove from local cache so UI updates immediately
    removeLocalDataset(datasetId);
    return true;
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
    return false;
  }
}
