// edit-mode.js — Inline click-to-edit for dataset detail pages.
// Click "Edit" to enter edit mode. Each field value becomes clickable.
// Click a value → inline input appears. A floating save bar tracks pending changes.
// Save → PATCH to Cloudflare Worker → R2 overlay → immediate effect.

import { els } from './state.js';
import { escapeHtml, deepClone, parseCsvList, compactObject, computeChanges, tryParseJson } from './utils.js';
import { getDatasetById, getAttributeById, getDatasetsForAttribute, applyLocalOverrides } from './catalog.js';
import { WORKER_BASE_URL } from './config.js';
import { buildGithubIssueUrlForEditedAttribute } from './github-issues.js';

// ── Field definitions ──

export const DATASET_EDIT_FIELDS = [
  // Catalog Metadata
  { key: 'title', label: 'Title', type: 'text', section: 'catalog' },
  { key: 'description', label: 'Description', type: 'textarea', section: 'catalog' },
  { key: 'objname', label: 'Database Object Name', type: 'text', section: 'catalog' },
  { key: 'topics', label: 'Topics', type: 'csv', section: 'catalog' },
  { key: 'agency_owner', label: 'Agency Owner', type: 'text', section: 'catalog' },
  { key: 'office_owner', label: 'Office Owner', type: 'text', section: 'catalog' },
  { key: 'contact_email', label: 'Contact Email', type: 'text', section: 'catalog' },
  { key: 'geometry_type', label: 'Geometry Type', type: 'text', section: 'catalog' },
  { key: 'update_frequency', label: 'Update Frequency', type: 'text', section: 'catalog' },
  { key: 'access_level', label: 'Access Level', type: 'text', section: 'catalog' },
  { key: 'public_web_service', label: 'Public Web Service', type: 'text', section: 'catalog' },
  { key: 'internal_web_service', label: 'Internal Web Service', type: 'text', section: 'catalog' },
  { key: 'data_standard', label: 'Data Standard', type: 'text', section: 'catalog' },
  { key: 'projection', label: 'Projection', type: 'text', section: 'catalog' },
  { key: 'notes', label: 'Notes', type: 'textarea', section: 'catalog' },

  // Development & Status
  { key: 'development_stage', label: 'Development Stage', type: 'select', options: ['planned', 'in_development', 'qa', 'production', 'deprecated'], section: 'devstatus' },
  { key: 'target_release_date', label: 'Target Release Date', type: 'text', section: 'devstatus' },
  { key: 'blockers', label: 'Blockers', type: 'csv', section: 'devstatus' },

  // National Scale Suitability
  { key: 'scale_suitability', label: 'Scale Suitability', type: 'select', options: ['national', 'regional', 'local'], section: 'scale' },
  { key: 'coverage', label: 'Coverage', type: 'select', options: ['nationwide', 'multi_state', 'single_state', 'partial'], section: 'scale' },
  { key: 'web_mercator_compatible', label: 'Web Mercator Compatible', type: 'boolean', section: 'scale' },
  { key: 'performance_notes', label: 'Performance Notes', type: 'textarea', section: 'scale' },
];

export const ATTRIBUTE_EDIT_FIELDS = [
  { key: 'label', label: 'Attribute Label', type: 'text' },
  { key: 'type', label: 'Attribute Type', type: 'text' },
  { key: 'definition', label: 'Attribute Definition', type: 'textarea' },
  { key: 'expected_value', label: 'Example Expected Value', type: 'text' },
  { key: 'values', label: 'Allowed values (JSON array)', type: 'json' },
];

// ── Admin token management ──

function getAdminToken() {
  return sessionStorage.getItem('gis_admin_token') || '';
}

function setAdminToken(token) {
  sessionStorage.setItem('gis_admin_token', token);
}

function promptAdminToken() {
  const token = prompt('Enter admin token:');
  if (token) setAdminToken(token.trim());
  return token ? token.trim() : '';
}

// ── Pending changes tracker ──

let _pendingChanges = {};   // { fieldKey: newValue }
let _originalValues = {};   // { fieldKey: originalValue }
let _activeDatasetId = null;
let _onDoneCallback = null;
let _saveBarEl = null;

function resetPending() {
  _pendingChanges = {};
  _originalValues = {};
  _activeDatasetId = null;
  hideSaveBar();
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
  updateSaveBar();
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

// ── Floating save bar ──

function createSaveBar() {
  if (_saveBarEl) return _saveBarEl;
  _saveBarEl = document.createElement('div');
  _saveBarEl.id = 'inline-edit-save-bar';
  _saveBarEl.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9998;background:var(--card-bg,#1e293b);border-top:2px solid var(--accent,#60a5fa);padding:0.6rem 1.2rem;display:none;align-items:center;justify-content:space-between;gap:1rem;box-shadow:0 -4px 16px rgba(0,0,0,0.4);';
  document.body.appendChild(_saveBarEl);
  return _saveBarEl;
}

function updateSaveBar() {
  const bar = createSaveBar();
  const count = getPendingCount();
  if (count === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <span style="font-size:0.9rem;color:var(--text-main,#e2e8f0);">
      <strong>${count}</strong> unsaved change${count !== 1 ? 's' : ''}
    </span>
    <div style="display:flex;gap:0.5rem;">
      <button type="button" class="btn" id="editDiscardBtn">Discard</button>
      <button type="button" class="btn primary" id="editSaveBtn">💾 Save changes</button>
    </div>
  `;
  bar.querySelector('#editDiscardBtn').addEventListener('click', () => {
    resetPending();
    if (_onDoneCallback) _onDoneCallback();
  });
  bar.querySelector('#editSaveBtn').addEventListener('click', () => saveChanges());
}

function hideSaveBar() {
  if (_saveBarEl) _saveBarEl.style.display = 'none';
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

  let token = getAdminToken();
  if (!token) token = promptAdminToken();
  if (!token) return;

  const bar = createSaveBar();
  const saveBtn = bar.querySelector('#editSaveBtn');
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

  try {
    const resp = await fetch(`${workerBase}/catalog/dataset/${encodeURIComponent(_activeDatasetId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ fields }),
    });

    const result = await resp.json();

    if (!resp.ok) {
      if (resp.status === 401) {
        sessionStorage.removeItem('gis_admin_token');
        alert('Invalid admin token. Please try again.');
      } else {
        alert(`Save failed: ${result.error || resp.statusText}`);
      }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save changes'; }
      return;
    }

    // Apply changes locally so UI updates without page reload
    applyLocalOverrides(_activeDatasetId, fields);

    resetPending();
    if (_onDoneCallback) _onDoneCallback();
  } catch (e) {
    alert(`Save failed: ${e.message}`);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save changes'; }
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

  // Confirm
  cell.querySelector('.inline-edit-ok').addEventListener('click', () => {
    const raw = input.value;
    recordChange(fieldDef.key, raw, originalVal);
    // Show updated display value
    const newDisplayVal = raw === '' ? originalVal : raw;
    const isPending = _pendingChanges.hasOwnProperty(fieldDef.key);
    cell.classList.remove('is-editing');
    cell.innerHTML = `<span class="inline-edit-value${isPending ? ' is-dirty' : ''}">${displayValue(fieldDef, fieldDef.type === 'csv' ? parseCsvList(raw || '') : (fieldDef.type === 'boolean' ? (raw === 'true' ? true : raw === 'false' ? false : newDisplayVal) : newDisplayVal))}</span>`;
    cell.classList.add('editable-field');
    wireFieldClick(cell, fieldDef, dataset);
  });

  // Cancel
  cell.querySelector('.inline-edit-cancel').addEventListener('click', () => {
    cell.classList.remove('is-editing');
    const isPending = _pendingChanges.hasOwnProperty(fieldDef.key);
    cell.innerHTML = `<span class="inline-edit-value${isPending ? ' is-dirty' : ''}">${displayValue(fieldDef, val)}</span>`;
    cell.classList.add('editable-field');
    wireFieldClick(cell, fieldDef, dataset);
  });
}

function wireFieldClick(cell, fieldDef, dataset) {
  cell.addEventListener('click', function handler() {
    cell.removeEventListener('click', handler);
    activateField(cell, fieldDef, dataset);
  }, { once: true });
}

// ── Dataset In-Place Edit ──

/**
 * Enter edit mode for a dataset's manual card.
 * Transforms each field value in the existing card to be clickable/editable.
 * @param {string} datasetId
 * @param {function} onDone - callback to re-render detail (exit edit mode)
 */
export function enterDatasetEditMode(datasetId, onDone) {
  const cardMeta = els.datasetDetailEl?.querySelector('.card.card-meta');
  if (!cardMeta) return;

  const dataset = getDatasetById(datasetId);
  if (!dataset) return;

  resetPending();
  _activeDatasetId = datasetId;
  _onDoneCallback = onDone;

  // Group fields by section
  const sections = {
    catalog: { title: 'Catalog Metadata', fields: [] },
    devstatus: { title: 'Development & Status', fields: [] },
    scale: { title: 'National Scale Suitability', fields: [] },
  };
  DATASET_EDIT_FIELDS.forEach(f => {
    const s = f.section || 'catalog';
    if (sections[s]) sections[s].fields.push(f);
  });

  let html = '';
  html += '<div class="card-header-row"><h3>Dataset Information</h3><span class="inline-edit-badge">✏️ Editing</span></div>';
  html += '<p style="font-size:0.8rem;color:var(--text-muted);margin:0.25rem 0 0.75rem;">Click any field value to edit it. Save all changes at once when done.</p>';

  Object.values(sections).forEach(sec => {
    if (!sec.fields.length) return;
    html += `<div class="manual-section">`;
    html += `<h4 class="manual-section-title">${escapeHtml(sec.title)}</h4>`;
    sec.fields.forEach(f => {
      const val = dataset[f.key];
      html += `<div class="inline-edit-row">
        <span class="inline-edit-label">${escapeHtml(f.label)}</span>
        <span class="inline-edit-cell editable-field" data-field-key="${escapeHtml(f.key)}">
          <span class="inline-edit-value">${displayValue(f, val)}</span>
        </span>
      </div>`;
    });
    html += `</div>`;
  });

  html += `
    <div class="manual-section-actions">
      <button type="button" class="btn" data-edit-cancel>Exit edit mode</button>
    </div>
  `;

  cardMeta.innerHTML = html;
  cardMeta.classList.add('is-editing');

  // Wire each field cell for click-to-edit
  cardMeta.querySelectorAll('.inline-edit-cell[data-field-key]').forEach(cell => {
    const key = cell.getAttribute('data-field-key');
    const fieldDef = DATASET_EDIT_FIELDS.find(f => f.key === key);
    if (fieldDef) wireFieldClick(cell, fieldDef, dataset);
  });

  // Wire cancel
  cardMeta.querySelector('[data-edit-cancel]')?.addEventListener('click', () => {
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
