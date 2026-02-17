// edit-mode.js — In-place editing for dataset and attribute detail pages.
// When "Edit" is clicked, the manual card swaps to editable inputs.
// Auto sections (coverage map, preview) stay untouched below.

import { els } from './state.js';
import { escapeHtml, deepClone, compactObject, computeChanges, parseCsvList, tryParseJson } from './utils.js';
import { getDatasetById, getAttributeById, getDatasetsForAttribute } from './catalog.js';
import { buildGithubIssueUrlForEditedDataset, buildGithubIssueUrlForEditedAttribute } from './github-issues.js';

// ── Field definitions ──

export const DATASET_EDIT_FIELDS = [
  // Catalog Metadata
  { key: 'title', label: 'Title', type: 'text', section: 'catalog' },
  { key: 'description', label: 'Description', type: 'textarea', section: 'catalog' },
  { key: 'objname', label: 'Database Object Name', type: 'text', section: 'catalog' },
  { key: 'topics', label: 'Topics (comma-separated)', type: 'csv', section: 'catalog' },
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
  { key: 'blockers', label: 'Blockers (comma-separated)', type: 'csv', section: 'devstatus' },

  // National Scale Suitability
  { key: 'scale_suitability', label: 'Scale Suitability', type: 'select', options: ['national', 'regional', 'local'], section: 'scale' },
  { key: 'coverage', label: 'Coverage', type: 'select', options: ['nationwide', 'multi_state', 'single_state', 'partial'], section: 'scale' },
  { key: 'web_mercator_compatible', label: 'Web Mercator Compatible', type: 'boolean', section: 'scale' },
  { key: 'performance_notes', label: 'Performance Notes', type: 'textarea', section: 'scale' },

  // Maturity
  { key: 'maturity.completeness', label: 'Completeness (%)', type: 'number', section: 'maturity' },
  { key: 'maturity.documentation', label: 'Documentation Level', type: 'select', options: ['none', 'minimal', 'partial', 'complete'], section: 'maturity' },
  { key: 'maturity.quality_tier', label: 'Quality Tier', type: 'select', options: ['bronze', 'silver', 'gold'], section: 'maturity' },
];

export const ATTRIBUTE_EDIT_FIELDS = [
  { key: 'label', label: 'Attribute Label', type: 'text' },
  { key: 'type', label: 'Attribute Type', type: 'text' },
  { key: 'definition', label: 'Attribute Definition', type: 'textarea' },
  { key: 'expected_value', label: 'Example Expected Value', type: 'text' },
  { key: 'values', label: 'Allowed values (JSON array) — for enumerated types', type: 'json' },
];

// ── Helpers ──

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function renderFieldInput(f, val) {
  if (f.type === 'textarea') {
    return `<textarea class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">${escapeHtml(val || '')}</textarea>`;
  }
  if (f.type === 'select' && Array.isArray(f.options)) {
    const opts = f.options.map(opt =>
      `<option value="${escapeHtml(opt)}" ${val === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
    return `<select class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}"><option value="">(select)</option>${opts}</select>`;
  }
  if (f.type === 'boolean') {
    return `<select class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">
      <option value="">(select)</option>
      <option value="true" ${val === true ? 'selected' : ''}>Yes</option>
      <option value="false" ${val === false ? 'selected' : ''}>No</option>
    </select>`;
  }
  if (f.type === 'number') {
    return `<input class="dataset-edit-input" type="number" data-edit-key="${escapeHtml(f.key)}" value="${val !== undefined ? escapeHtml(String(val)) : ''}" />`;
  }
  if (f.type === 'json') {
    const display = (val === undefined || val === null) ? '' : JSON.stringify(val, null, 2);
    return `<textarea class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">${escapeHtml(display)}</textarea>`;
  }
  // text, csv
  const displayVal = f.type === 'csv' && Array.isArray(val) ? val.join(', ') : (val || '');
  return `<input class="dataset-edit-input" type="text" data-edit-key="${escapeHtml(f.key)}" value="${escapeHtml(displayVal)}" />`;
}

// ── Dataset In-Place Edit ──

/**
 * Enter edit mode for a dataset's manual card.
 * Replaces the .card.card-meta content with editable inputs.
 * @param {string} datasetId
 * @param {function} onDone - callback to re-render detail (exit edit mode)
 */
export function enterDatasetEditMode(datasetId, onDone) {
  const cardMeta = els.datasetDetailEl?.querySelector('.card.card-meta');
  if (!cardMeta) return;

  const dataset = getDatasetById(datasetId);
  if (!dataset) return;

  const original = deepClone(dataset);

  // Group fields by section
  const sections = {
    catalog: { title: 'Catalog Metadata', fields: [] },
    devstatus: { title: 'Development & Status', fields: [] },
    scale: { title: 'National Scale Suitability', fields: [] },
    maturity: { title: 'Data Maturity', fields: [] },
  };
  DATASET_EDIT_FIELDS.forEach(f => {
    const s = f.section || 'catalog';
    if (sections[s]) sections[s].fields.push(f);
  });

  let html = '';
  html += '<div class="card-header-row"><h3>Dataset Information</h3><span class="data-source-badge data-source-badge-manual">Manual</span></div>';

  // Action buttons at top
  html += `<div class="edit-mode-actions">
    <button type="button" class="btn" data-edit-cancel>Cancel</button>
    <button type="button" class="btn primary" data-edit-save>Submit change request</button>
  </div>`;

  // Render sections
  Object.values(sections).forEach(sec => {
    if (!sec.fields.length) return;
    html += `<div class="manual-section">`;
    html += `<h4 class="manual-section-title">${escapeHtml(sec.title)}</h4>`;
    sec.fields.forEach(f => {
      const val = getNestedValue(dataset, f.key);
      html += `<div class="dataset-edit-row">
        <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
        ${renderFieldInput(f, val)}
      </div>`;
    });
    html += `</div>`;
  });

  cardMeta.innerHTML = html;
  cardMeta.classList.add('is-editing');

  // Wire cancel
  const cancelBtn = cardMeta.querySelector('[data-edit-cancel]');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (onDone) onDone();
    });
  }

  // Wire save
  const saveBtn = cardMeta.querySelector('[data-edit-save]');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const draft = deepClone(original);

      const inputs = cardMeta.querySelectorAll('[data-edit-key]');
      inputs.forEach(el => {
        const k = el.getAttribute('data-edit-key');
        const raw = el.value;
        const fieldDef = DATASET_EDIT_FIELDS.find(x => x.key === k);
        let parsedValue;

        if (fieldDef && fieldDef.type === 'csv') {
          parsedValue = parseCsvList(raw);
        } else if (fieldDef && fieldDef.type === 'boolean') {
          if (raw === 'true') parsedValue = true;
          else if (raw === 'false') parsedValue = false;
          else parsedValue = undefined;
        } else if (fieldDef && fieldDef.type === 'number') {
          const num = parseFloat(raw);
          parsedValue = isNaN(num) ? undefined : num;
        } else {
          parsedValue = String(raw || '').trim() || undefined;
        }

        if (k.includes('.')) {
          setNestedValue(draft, k, parsedValue);
        } else {
          draft[k] = parsedValue;
        }
      });

      const updated = compactObject(draft);
      const origCompact = compactObject(original);
      const changes = computeChanges(origCompact, updated);

      if (!changes.length) {
        alert('No changes detected.');
        return;
      }

      const issueUrl = buildGithubIssueUrlForEditedDataset(datasetId, origCompact, updated, changes);

      // Restore read-only view
      if (onDone) onDone();

      // Open pre-filled issue
      window.open(issueUrl, '_blank', 'noopener');
    });
  }
}

// ── Attribute In-Place Edit ──

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

  // Action buttons at top
  html += `<div class="edit-mode-actions">
    <button type="button" class="btn" data-edit-cancel>Cancel</button>
    <button type="button" class="btn primary" data-edit-save>Submit change request</button>
  </div>`;

  // Render fields
  ATTRIBUTE_EDIT_FIELDS.forEach(f => {
    const val = attribute[f.key];
    html += `<div class="dataset-edit-row">
      <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
      ${renderFieldInput(f, val)}
    </div>`;
  });

  cardMeta.innerHTML = html;
  cardMeta.classList.add('is-editing');

  // Wire cancel
  const cancelBtn = cardMeta.querySelector('[data-edit-cancel]');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (onDone) onDone();
    });
  }

  // Wire save
  const saveBtn = cardMeta.querySelector('[data-edit-save]');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const draft = deepClone(original);
      let hadError = false;

      const inputs = cardMeta.querySelectorAll('[data-edit-key]');
      inputs.forEach(el => {
        const k = el.getAttribute('data-edit-key');
        const raw = el.value;
        const def = ATTRIBUTE_EDIT_FIELDS.find(x => x.key === k);

        if (def && def.type === 'json') {
          const parsed = tryParseJson(raw);
          if (parsed && parsed.__parse_error__) {
            alert(`Allowed values JSON parse error:\n${parsed.__parse_error__}`);
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

      // Restore read-only view
      if (onDone) onDone();

      // Open pre-filled issue
      window.open(issueUrl, '_blank', 'noopener');
    });
  }
}
