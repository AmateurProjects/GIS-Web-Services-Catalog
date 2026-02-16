// forms.js — Form rendering functions (dataset edit, attribute edit, new dataset, new attribute)
import { state, els } from './state.js';
import { escapeHtml, compactObject, parseCsvList, tryParseJson, deepClone, computeChanges } from './utils.js';
import { animatePanel, staggerCards } from './ui-fx.js';
import { getDatasetById, getAttributeById, getAttributesForDataset, getDatasetsForAttribute } from './catalog.js';
import { buildGithubIssueUrlForEditedDataset, buildGithubIssueUrlForNewDataset, buildGithubIssueUrlForEditedAttribute, buildGithubIssueUrlForNewAttributes } from './github-issues.js';
import { showDatasetsView, showAttributesView, goBackToLastDatasetOrList, goBackToAttributesListOrFirst } from './navigation.js';

// --- Lazy callbacks for detail renderers (circular dep avoidance) ---
let _renderDatasetDetail = null;
let _renderAttributeDetail = null;
let _renderInlineAttributeDetail = null;

export function registerFormCallbacks({ renderDatasetDetail, renderAttributeDetail, renderInlineAttributeDetail }) {
  _renderDatasetDetail = renderDatasetDetail;
  _renderAttributeDetail = renderAttributeDetail;
  _renderInlineAttributeDetail = renderInlineAttributeDetail;
}

// NOTE: DATASET_EDIT_FIELDS drives BOTH "Suggest change" and "Submit new dataset" pages

const DATASET_EDIT_FIELDS = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'description', label: 'Description', type: 'textarea' },

  { key: 'objname', label: 'Database Object Name', type: 'text' },
  { key: 'topics', label: 'Topics (comma-separated)', type: 'csv' },

  { key: 'agency_owner', label: 'Agency Owner', type: 'text' },
  { key: 'office_owner', label: 'Office Owner', type: 'text' },
  { key: 'contact_email', label: 'Contact Email', type: 'text' },

  { key: 'geometry_type', label: 'Geometry Type', type: 'text' },
  { key: 'update_frequency', label: 'Update Frequency', type: 'text' },

  { key: 'status', label: 'Status', type: 'text' },
  { key: 'access_level', label: 'Access Level', type: 'text' },

  { key: 'public_web_service', label: 'Public Web Service', type: 'text' },
  { key: 'internal_web_service', label: 'Internal Web Service', type: 'text' },
  { key: 'data_standard', label: 'Data Standard', type: 'text' },

  { key: 'notes', label: 'Notes', type: 'textarea' },
  
  // Development & Status
  { key: 'development_stage', label: 'Development Stage', type: 'select', options: ['planned', 'in_development', 'qa', 'production', 'deprecated'] },
  { key: 'target_release_date', label: 'Target Release Date', type: 'text' },
  { key: 'blockers', label: 'Blockers (comma-separated)', type: 'csv' },
  
  // National Scale Suitability
  { key: 'scale_suitability', label: 'Scale Suitability', type: 'select', options: ['national', 'regional', 'local'] },
  { key: 'coverage', label: 'Coverage', type: 'select', options: ['nationwide', 'multi_state', 'single_state', 'partial'] },
  { key: 'web_mercator_compatible', label: 'Web Mercator Compatible', type: 'boolean' },
  { key: 'performance_notes', label: 'Performance Notes', type: 'textarea' },
  
  // Maturity
  { key: 'maturity.completeness', label: 'Completeness (%)', type: 'number' },
  { key: 'maturity.documentation', label: 'Documentation Level', type: 'select', options: ['none', 'minimal', 'partial', 'complete'] },
  { key: 'maturity.quality_tier', label: 'Quality Tier', type: 'select', options: ['bronze', 'silver', 'gold'] },
];

// --- Edit Fields for Suggest Attribute Change functionality ---
const ATTRIBUTE_EDIT_FIELDS = [
  { key: 'label', label: 'Attribute Label', type: 'text' },
  { key: 'type', label: 'Attribute Type', type: 'text' }, // you can later make this a select
  { key: 'definition', label: 'Attribute Definition', type: 'textarea' },
  { key: 'expected_value', label: 'Example Expected Value', type: 'text' },
  { key: 'values', label: 'Allowed values (JSON array) — for enumerated types', type: 'json' },
];


export function renderDatasetEditForm(datasetId) {
    if (!els.datasetDetailEl) return;

    const dataset = getDatasetById(datasetId);
    if (!dataset) return;

    const original = deepClone(dataset);
    const draft = deepClone(dataset);
    const attrs = getAttributesForDataset(dataset);

    let html = '';

    // Breadcrumb
    html += `
    <nav class="breadcrumb">
      <button type="button" class="breadcrumb-root" data-breadcrumb="datasets">Datasets</button>
      <span class="breadcrumb-separator">/</span>
      <span class="breadcrumb-current">${escapeHtml(dataset.title || dataset.id)}</span>
    </nav>
  `;

    html += `<h2>Editing: ${escapeHtml(dataset.title || dataset.id)}</h2>`;
    if (dataset.description) html += `<p>${escapeHtml(dataset.description)}</p>`;

    // Helper to get nested value from draft
    function getNestedValue(obj, path) {
      return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
    }

    // Form container
    html += `<div class="card card-meta" id="datasetEditCard">`;
    html += `<div class="dataset-edit-actions">
      <button type="button" class="btn" data-edit-cancel>Cancel</button>
      <button type="button" class="btn primary" data-edit-submit>Submit suggestion</button>
    </div>`;

    // Fields
    DATASET_EDIT_FIELDS.forEach((f) => {
      const val = getNestedValue(draft, f.key);

      if (f.type === 'textarea') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <textarea class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">${escapeHtml(
          val || ''
        )}</textarea>
        </div>
      `;
      } else if (f.type === 'select' && Array.isArray(f.options)) {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <select class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">
            <option value="">(select)</option>
            ${f.options.map(opt => `<option value="${escapeHtml(opt)}" ${val === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
          </select>
        </div>
      `;
      } else if (f.type === 'boolean') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <select class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">
            <option value="">(select)</option>
            <option value="true" ${val === true ? 'selected' : ''}>Yes</option>
            <option value="false" ${val === false ? 'selected' : ''}>No</option>
          </select>
        </div>
      `;
      } else if (f.type === 'number') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <input class="dataset-edit-input" type="number" data-edit-key="${escapeHtml(f.key)}" value="${val !== undefined ? escapeHtml(String(val)) : ''}" />
        </div>
      `;
      } else {
        const displayVal =
          f.type === 'csv' && Array.isArray(val) ? val.join(', ') : (val || '');
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <input class="dataset-edit-input" type="text" data-edit-key="${escapeHtml(
          f.key
        )}" value="${escapeHtml(displayVal)}" />
        </div>
      `;
      }
    });

    html += `</div>`;

    // Keep attributes section unchanged (read-only), as requested
    html += `
    <div class="card-row">
      <div class="card card-attributes">
        <h3>Attributes</h3>
  `;

    if (!attrs.length) {
      html += '<p>No attributes defined for this dataset.</p>';
    } else {
      html += '<ul>';
      attrs.forEach((attr) => {
        html += `
        <li>
          <button type="button" class="link-button" data-attr-id="${escapeHtml(attr.id)}">
            ${escapeHtml(attr.id)} – ${escapeHtml(attr.label || '')}
          </button>
        </li>`;
      });
      html += '</ul>';
    }

    html += `
      </div>
      <div class="card card-inline-attribute" id="inlineAttributeDetail">
        <h3>Attribute details</h3>
        <p>Select an attribute from the list to see its properties here without leaving this dataset.</p>
      </div>
    </div>
  `;

    els.datasetDetailEl.innerHTML = html;
    els.datasetDetailEl.classList.remove('hidden');

    // Bounce + stagger cards (same feel as detail pages)
    staggerCards(els.datasetDetailEl);
    animatePanel(els.datasetDetailEl);

    // Breadcrumb
    const rootBtn = els.datasetDetailEl.querySelector('button[data-breadcrumb="datasets"]');
    if (rootBtn) rootBtn.addEventListener('click', showDatasetsView);

    // Inline attribute hooks
    const attrButtons = els.datasetDetailEl.querySelectorAll('button[data-attr-id]');
    attrButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const attrId = btn.getAttribute('data-attr-id');
        if (_renderInlineAttributeDetail) _renderInlineAttributeDetail(attrId);
      });
    });

    // Cancel -> back to normal view
    const cancelBtn = els.datasetDetailEl.querySelector('button[data-edit-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { if (_renderDatasetDetail) _renderDatasetDetail(datasetId); });

    // Submit -> collect values, compute diff, open issue
    const submitBtn = els.datasetDetailEl.querySelector('button[data-edit-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // Helper to set nested value in draft
        function setNestedValue(obj, path, value) {
          const keys = path.split('.');
          let current = obj;
          for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]]) current[keys[i]] = {};
            current = current[keys[i]];
          }
          current[keys[keys.length - 1]] = value;
        }

        const inputs = els.datasetDetailEl.querySelectorAll('[data-edit-key]');
        inputs.forEach((el) => {
          const k = el.getAttribute('data-edit-key');
          const raw = el.value;

          const fieldDef = DATASET_EDIT_FIELDS.find((x) => x.key === k);
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

          // Handle nested keys like maturity.completeness
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

        // Return UI to normal view right away
        if (_renderDatasetDetail) _renderDatasetDetail(datasetId);

        // Then open the GitHub issue in a new tab
        window.open(issueUrl, '_blank', 'noopener');

      });
    }
  }


  // --- NEW ATTRIBUTE "editable page" (replaces the modal) ---
  export function renderNewAttributeCreateForm(prefill = {}) {
    // Use attribute detail panel when we are on the Attributes tab;
    // otherwise fall back to dataset detail panel (rare).
    const hostEl = els.attributeDetailEl || els.datasetDetailEl;
    if (!hostEl) return;

    const NEW_ATTR_PLACEHOLDERS =
      (state.catalogData &&
        state.catalogData.ui &&
        state.catalogData.ui.placeholders &&
        state.catalogData.ui.placeholders.new_attribute) ||
      {};

    function placeholderFor(key, fallback = '') {
      return escapeHtml(NEW_ATTR_PLACEHOLDERS[key] || fallback || '');
    }

    // draft supports both single + bulk modes
    const draft = {
      mode: 'single', // 'single' | 'bulk'
      id: '',
      label: '',
      type: '',
      definition: '',
      expected_value: '',
      values_json: '',
      notes: '',
      bulk_json: '',
      bulk_notes: '',
      ...deepClone(prefill || {}),
    };

    let html = '';

    // Breadcrumb (Attributes)
    html += `
      <nav class="breadcrumb">
        <button type="button" class="breadcrumb-root" data-breadcrumb="attributes">Attributes</button>
        <span class="breadcrumb-separator">/</span>
        <span class="breadcrumb-current">Add new attribute</span>
      </nav>
    `;

    html += `<h2>Add a new attribute</h2>`;
    html += `<p class="modal-help">This will open a pre-filled GitHub Issue for review/approval by the catalog owner.</p>`;

    // Mode toggle
    html += `
      <div class="card card-meta">
        <div class="dataset-edit-actions">
          <button type="button" class="btn ${draft.mode === 'single' ? 'primary' : ''}" data-new-attr-mode="single">Single</button>
          <button type="button" class="btn ${draft.mode === 'bulk' ? 'primary' : ''}" data-new-attr-mode="bulk">Bulk JSON</button>
          <span style="flex:1"></span>
          <button type="button" class="btn" data-new-attr-cancel>Cancel</button>
          <button type="button" class="btn primary" data-new-attr-submit>Submit suggestion</button>
        </div>
      </div>
    `;

    // Single form card
    html += `<div class="card card-attribute-meta" id="newAttrSingleCard" ${draft.mode === 'bulk' ? 'style="display:none"' : ''}>`;

    // Attribute ID first (required)
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Attribute ID (required)</label>
        <input class="dataset-edit-input" type="text" data-new-attr-key="id"
               placeholder="${placeholderFor('id', 'e.g., STATE_NAME')}"
               value="${escapeHtml(draft.id || '')}" />
      </div>
    `;

    // Use your existing field list so the "feel" matches edit mode
    ATTRIBUTE_EDIT_FIELDS.forEach((f) => {
      // note: your attribute object uses expected_value but the edit fields key is expected_value already
      const k = f.key;
      let val = '';
      if (k === 'values') val = draft.values_json || '';
      else val = draft[k] === undefined ? '' : String(draft[k] || '');

      if (f.type === 'textarea' || f.type === 'json') {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <textarea class="dataset-edit-input" data-new-attr-key="${escapeHtml(k)}"
              placeholder="${placeholderFor(k)}">${escapeHtml(val)}</textarea>
          </div>
        `;
      } else {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <input class="dataset-edit-input" type="text" data-new-attr-key="${escapeHtml(k)}"
              placeholder="${placeholderFor(k)}"
              value="${escapeHtml(val)}" />
          </div>
        `;
      }
    });

    // Notes
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Notes / context (optional)</label>
        <textarea class="dataset-edit-input" data-new-attr-key="notes"
          placeholder="${placeholderFor('notes', 'any extra context for reviewers')}">${escapeHtml(draft.notes || '')}</textarea>
      </div>
    `;

    html += `</div>`;

    // Bulk form card
    html += `<div class="card card-attribute-meta" id="newAttrBulkCard" ${draft.mode === 'single' ? 'style="display:none"' : ''}>`;
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Bulk attributes JSON (required)</label>
        <textarea class="dataset-edit-input" data-new-attr-bulk="json" rows="12"
          placeholder="${placeholderFor('bulk_attributes_json', '[{ \"id\": \"...\", \"label\": \"...\" }]')}">${escapeHtml(draft.bulk_json || '')}</textarea>
      </div>
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Notes / context (optional)</label>
        <textarea class="dataset-edit-input" data-new-attr-bulk="notes"
          placeholder="${placeholderFor('bulk_notes', 'any extra context for reviewers')}">${escapeHtml(draft.bulk_notes || '')}</textarea>
      </div>
    `;
    html += `</div>`;

    hostEl.innerHTML = html;
    hostEl.classList.remove('hidden');

    // Bounce + stagger cards (same feel as detail pages)
    staggerCards(hostEl);
    animatePanel(hostEl);

    // Breadcrumb root
    const rootBtn = hostEl.querySelector('button[data-breadcrumb="attributes"]');
    if (rootBtn) rootBtn.addEventListener('click', showAttributesView);

    // Cancel -> back to list/first attribute
    const cancelBtn = hostEl.querySelector('button[data-new-attr-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', goBackToAttributesListOrFirst);

    // Mode switching
    const modeBtns = hostEl.querySelectorAll('button[data-new-attr-mode]');
    const singleCard = hostEl.querySelector('#newAttrSingleCard');
    const bulkCard = hostEl.querySelector('#newAttrBulkCard');
    modeBtns.forEach((b) => {
      b.addEventListener('click', () => {
        const mode = b.getAttribute('data-new-attr-mode');
        const isBulk = mode === 'bulk';
        if (singleCard) singleCard.style.display = isBulk ? 'none' : '';
        if (bulkCard) bulkCard.style.display = isBulk ? '' : 'none';
        modeBtns.forEach((x) => {
          const active = x.getAttribute('data-new-attr-mode') === mode;
          x.classList.toggle('primary', active);
        });
      });
    });

    // Submit -> validate, build payload, open issue, then return UI to normal view
    const submitBtn = hostEl.querySelector('button[data-new-attr-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // determine mode from which card is visible
        const isBulk = bulkCard && bulkCard.style.display !== 'none';

        let attributesPayload = [];
        let notes = '';

        if (isBulk) {
          const raw = String(hostEl.querySelector('[data-new-attr-bulk="json"]')?.value || '').trim();
          notes = String(hostEl.querySelector('[data-new-attr-bulk="notes"]')?.value || '').trim();

          const parsed = tryParseJson(raw);
          if (!parsed) {
            alert('Bulk JSON is required.');
            return;
          }
          if (parsed.__parse_error__) {
            alert(`Bulk JSON parse error:\n${parsed.__parse_error__}`);
            return;
          }
          if (!Array.isArray(parsed)) {
            alert('Bulk JSON must be a JSON array of attribute objects.');
            return;
          }
          attributesPayload = parsed;
        } else {
          const getVal = (k) => String(hostEl.querySelector(`[data-new-attr-key="${k}"]`)?.value || '').trim();

          const id = getVal('id');
          if (!id) {
            alert('Attribute ID is required.');
            return;
          }

          const type = getVal('type');
          const definition = getVal('definition');
          const label = getVal('label');
          const expectedValueRaw = getVal('expected_value');
          notes = getVal('notes');

          let values = undefined;
          if (type === 'enumerated') {
            const valuesRaw = getVal('values');
            if (valuesRaw) {
              const parsedValues = tryParseJson(valuesRaw);
              if (parsedValues && parsedValues.__parse_error__) {
                alert(`Enumerated values JSON parse error:\n${parsedValues.__parse_error__}`);
                return;
              }
              if (parsedValues && !Array.isArray(parsedValues)) {
                alert('Enumerated values must be a JSON array of objects like {code,label,description}.');
                return;
              }
              values = parsedValues || [];
            } else {
              values = [];
            }
          }

          const attrObj = compactObject({
            id,
            label,
            type,
            definition,
            expected_value: expectedValueRaw || undefined,
            values,
          });

          const exists = getAttributeById(id);
          if (exists) {
            const proceed = confirm(`An attribute with ID "${id}" already exists. Open an issue anyway?`);
            if (!proceed) return;
          }

          attributesPayload = [attrObj];
        }

        const missingIds = attributesPayload.filter((a) => !a || typeof a !== 'object' || !a.id).length;
        if (missingIds) {
          alert('One or more attribute objects are missing an "id" field.');
          return;
        }

        const payload = {
          title:
            attributesPayload.length === 1
              ? `New attribute request: ${attributesPayload[0].id}`
              : `New attributes request (${attributesPayload.length})`,
          attributes: attributesPayload,
          notes,
        };

        const issueUrl = buildGithubIssueUrlForNewAttributes(payload);

        // Return UI to normal attribute view immediately
        goBackToAttributesListOrFirst();

        const w = window.open(issueUrl, '_blank', 'noopener');
        if (!w) alert('Popup blocked — please allow popups to open the GitHub Issue.');
      });
    }
  }


    // --- NEW DATASET "editable page" (replaces the modal) ---
   export function renderNewDatasetCreateForm(prefill = {}) {
    if (!els.datasetDetailEl) return;

    // Placeholder strings come from data/catalog.json so you can edit without touching JS
    const NEW_DATASET_PLACEHOLDERS =
      (state.catalogData &&
        state.catalogData.ui &&
        state.catalogData.ui.placeholders &&
        state.catalogData.ui.placeholders.new_dataset) ||
      {};

    function placeholderFor(key, fallback = '') {
      return escapeHtml(NEW_DATASET_PLACEHOLDERS[key] || fallback || '');
    }

// NOTE: goBackToLastDatasetOrList() is defined in navigation.js


    // Start with a blank draft; allow optional prefill (future use)
    const draft = {
      id: '',
      title: '',
      description: '',
      objname: '',
      topics: [],
      agency_owner: '',
      office_owner: '',
      contact_email: '',
      geometry_type: '',
      update_frequency: '',
      status: '',
      access_level: '',
      public_web_service: '',
      internal_web_service: '',
      data_standard: '',
      projection: '',
      notes: '',
      // NEW: attribute selection/creation
      attribute_ids: [],       // existing attribute IDs selected
      new_attributes: [],      // array of new attribute draft objects

      ...deepClone(prefill || {}),
    };

    let html = '';

    // Breadcrumb
    html += `
      <nav class="breadcrumb">
        <button type="button" class="breadcrumb-root" data-breadcrumb="datasets">Datasets</button>
        <span class="breadcrumb-separator">/</span>
        <span class="breadcrumb-current">Submit new dataset</span>
      </nav>
    `;

    html += `<h2>Submit a new dataset</h2>`;
    html += `<p class="modal-help">This will open a pre-filled GitHub Issue for review/approval by the catalog owner.</p>`;

    html += `<div class="card card-meta" id="newDatasetEditCard">`;
    html += `
      <div class="dataset-edit-actions">
        <button type="button" class="btn" data-new-ds-cancel>Cancel</button>
        <button type="button" class="btn primary" data-new-ds-submit>Submit suggestion</button>
      </div>
    `;

    // Dataset ID (required) — shown first
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Dataset ID (required)</label>
        <input class="dataset-edit-input" type="text" data-new-ds-key="id"
               placeholder="${placeholderFor('id', 'e.g., blm_rmp_boundaries')}"
               value="${escapeHtml(draft.id || '')}" />
      </div>
    `;

    // Render the rest using the same field list you use for edit mode
    DATASET_EDIT_FIELDS.forEach((f) => {
      const val = f.key.includes('.') ? f.key.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, draft) : draft[f.key];

      if (f.type === 'textarea') {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <textarea class="dataset-edit-input" data-new-ds-key="${escapeHtml(f.key)}"
                      placeholder="${placeholderFor(f.key)}">${escapeHtml(val || '')}</textarea>
          </div>
        `;
      } else if (f.type === 'select' && Array.isArray(f.options)) {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <select class="dataset-edit-input" data-new-ds-key="${escapeHtml(f.key)}">
              <option value="">(select)</option>
              ${f.options.map(opt => `<option value="${escapeHtml(opt)}" ${val === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
            </select>
          </div>
        `;
      } else if (f.type === 'boolean') {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <select class="dataset-edit-input" data-new-ds-key="${escapeHtml(f.key)}">
              <option value="">(select)</option>
              <option value="true" ${val === true ? 'selected' : ''}>Yes</option>
              <option value="false" ${val === false ? 'selected' : ''}>No</option>
            </select>
          </div>
        `;
      } else if (f.type === 'number') {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <input class="dataset-edit-input" type="number" data-new-ds-key="${escapeHtml(f.key)}"
                   placeholder="${placeholderFor(f.key)}"
                   value="${val !== undefined ? escapeHtml(String(val)) : ''}" />
          </div>
        `;
      } else {
        const displayVal =
          f.type === 'csv' && Array.isArray(val) ? val.join(', ') : (val || '');
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <input class="dataset-edit-input" type="text" data-new-ds-key="${escapeHtml(f.key)}"
                   placeholder="${placeholderFor(f.key)}"
                   value="${escapeHtml(displayVal)}" />
         </div>
        `;
      }
    });

    html += `</div>`;

  // ---------------------------
  // Attributes section (existing + new)
  // ---------------------------

  // Datalist options for existing attributes
  const attrOptions = (state.allAttributes || [])
    .map((a) => {
      const id = a.id || '';
      const label = a.label ? ` — ${a.label}` : '';
      return `<option value="${escapeHtml(id)}">${escapeHtml(id + label)}</option>`;
    })
    .join('');

  html += `
    <div class="card card-meta" id="newDatasetAttributesCard">
      <h3>Attributes</h3>
      <p class="modal-help" style="margin-top:0.25rem;">
        Add existing attributes, or create new ones inline. New attributes will be included in the GitHub issue.
      </p>

      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Add existing attribute (search by ID)</label>
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <input class="dataset-edit-input" style="flex:1;" type="text"
            list="existingAttributesDatalist"
            data-new-ds-existing-attr-input
            placeholder="Start typing an attribute ID..." />
          <button type="button" class="btn" data-new-ds-add-existing-attr>Add</button>
        </div>
        <datalist id="existingAttributesDatalist">
          ${attrOptions}
        </datalist>
      </div>

      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Selected attributes</label>
        <div data-new-ds-selected-attrs style="display:flex; flex-wrap:wrap; gap:0.5rem;"></div>
      </div>

      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Create new attribute</label>
        <div>
          <button type="button" class="btn" data-new-ds-add-new-attr>+ Add new attribute</button>
        </div>
      </div>

      <div data-new-ds-new-attrs></div>
    </div>
  `;


    els.datasetDetailEl.innerHTML = html;
    els.datasetDetailEl.classList.remove('hidden');

  // ---------- Attributes UI wiring ----------

  const selectedAttrsEl = els.datasetDetailEl.querySelector('[data-new-ds-selected-attrs]');
  const existingAttrInput = els.datasetDetailEl.querySelector('[data-new-ds-existing-attr-input]');
  const addExistingBtn = els.datasetDetailEl.querySelector('button[data-new-ds-add-existing-attr]');
  const addNewAttrBtn = els.datasetDetailEl.querySelector('button[data-new-ds-add-new-attr]');
  const newAttrsHost = els.datasetDetailEl.querySelector('[data-new-ds-new-attrs]');

  const NEW_ATTR_PLACEHOLDERS =
    (state.catalogData &&
      state.catalogData.ui &&
      state.catalogData.ui.placeholders &&
      state.catalogData.ui.placeholders.new_attribute) ||
    {};
  function attrPlaceholderFor(key, fallback = '') {
    return escapeHtml(NEW_ATTR_PLACEHOLDERS[key] || fallback || '');
  }

  function renderSelectedAttrChips() {
    if (!selectedAttrsEl) return;
    const ids = Array.from(new Set((draft.attribute_ids || []).map((x) => String(x || '').trim()).filter(Boolean)));
    draft.attribute_ids = ids;

    selectedAttrsEl.innerHTML = ids.length
      ? ids
          .map(
            (id) => `
              <span class="pill pill-keyword" style="display:inline-flex; gap:0.4rem; align-items:center;">
                <span>${escapeHtml(id)}</span>
                <button type="button" class="icon-button" style="padding:0.15rem 0.35rem;" data-remove-attr-id="${escapeHtml(id)}">✕</button>
              </span>
            `
          )
          .join('')
      : `<span style="color: var(--text-muted);">None selected yet.</span>`;

    // remove handlers
    selectedAttrsEl.querySelectorAll('button[data-remove-attr-id]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-remove-attr-id');
        draft.attribute_ids = (draft.attribute_ids || []).filter((x) => x !== id);
        renderSelectedAttrChips();
      });
    });
  }

  function makeNewAttrDraft() {
    return {
      id: '',
      label: '',
      type: '',
      definition: '',
      expected_value: '',
      values_json: '',
      notes: '',
    };
  }

  function renderNewAttributesForms() {
    if (!newAttrsHost) return;
    const arr = draft.new_attributes || [];
    if (!arr.length) {
      newAttrsHost.innerHTML = '';
      return;
    }

    newAttrsHost.innerHTML = arr
      .map((a, idx) => {
        const safeIdx = String(idx);
        return `
          <div class="card" style="margin-top:0.75rem;" data-new-attr-card data-new-attr-idx="${safeIdx}">
            <div class="dataset-edit-actions" style="margin-bottom:0.75rem;">
              <strong style="align-self:center;">New attribute #${idx + 1}</strong>
              <span style="flex:1"></span>
              <button type="button" class="btn" data-remove-new-attr="${safeIdx}">Remove</button>
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute ID (required)</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="id"
                placeholder="${attrPlaceholderFor('id', 'e.g., STATE_NAME')}"
                value="${escapeHtml(a.id || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute Label</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="label"
                placeholder="${attrPlaceholderFor('label', 'Human-friendly label')}"
                value="${escapeHtml(a.label || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute Type</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="type"
                placeholder="${attrPlaceholderFor('type', 'string / integer / enumerated / ...')}"
                value="${escapeHtml(a.type || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute Definition</label>
              <textarea class="dataset-edit-input"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="definition"
                placeholder="${attrPlaceholderFor('definition', 'What this attribute means and how it is used')}">${escapeHtml(a.definition || '')}</textarea>
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Example Expected Value</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="expected_value"
                placeholder="${attrPlaceholderFor('expected_value', 'Optional example')}"
                value="${escapeHtml(a.expected_value || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Allowed values (JSON array) — only if type = enumerated</label>
              <textarea class="dataset-edit-input"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="values_json"
                placeholder='${attrPlaceholderFor(
                  'values',
                  '[{"code":1,"label":"Yes","description":"..."},{"code":0,"label":"No"}]'
                )}'>${escapeHtml(a.values_json || '')}</textarea>
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Notes / context (optional)</label>
              <textarea class="dataset-edit-input"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="notes"
                placeholder="${attrPlaceholderFor('notes', 'Any context for reviewers')}">${escapeHtml(a.notes || '')}</textarea>
            </div>
          </div>
        `;
      })
      .join('');

    // Remove new attribute handlers
    newAttrsHost.querySelectorAll('button[data-remove-new-attr]').forEach((b) => {
      b.addEventListener('click', () => {
        const idx = Number(b.getAttribute('data-remove-new-attr'));
        if (Number.isNaN(idx)) return;
        draft.new_attributes.splice(idx, 1);
        renderNewAttributesForms();
      });
    });
  }

  if (addExistingBtn) {
    addExistingBtn.addEventListener('click', () => {
      const raw = String(existingAttrInput?.value || '').trim();
      if (!raw) return;
      const exists = getAttributeById(raw);
      if (!exists) {
        alert(`Attribute "${raw}" doesn't exist yet. Use "Add new attribute" to propose it.`);
        return;
      }
      draft.attribute_ids = draft.attribute_ids || [];
      if (!draft.attribute_ids.includes(raw)) draft.attribute_ids.push(raw);
      if (existingAttrInput) existingAttrInput.value = '';
      renderSelectedAttrChips();
    });
  }

  if (addNewAttrBtn) {
    addNewAttrBtn.addEventListener('click', () => {
      draft.new_attributes = draft.new_attributes || [];
      draft.new_attributes.push(makeNewAttrDraft());
      renderNewAttributesForms();
    });
  }

  // Initial paints
  renderSelectedAttrChips();
  renderNewAttributesForms();

    // Bounce + stagger cards (same feel as detail pages)
    staggerCards(els.datasetDetailEl);
    animatePanel(els.datasetDetailEl);

    // Breadcrumb root
    const rootBtn = els.datasetDetailEl.querySelector('button[data-breadcrumb="datasets"]');
    if (rootBtn) rootBtn.addEventListener('click', showDatasetsView);

    // Cancel: return to "normal" dataset view (first dataset) or just show list
    const cancelBtn = els.datasetDetailEl.querySelector('button[data-new-ds-cancel]');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
      goBackToLastDatasetOrList();
      });
    }

    // Submit: validate, build payload, open issue, then return UI to normal view
    const submitBtn = els.datasetDetailEl.querySelector('button[data-new-ds-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // Helper to set nested value (e.g. maturity.completeness)
        function setNestedValue(obj, path, value) {
          const keys = path.split('.');
          let current = obj;
          for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]]) current[keys[i]] = {};
            current = current[keys[i]];
          }
          current[keys[keys.length - 1]] = value;
        }

        const inputs = els.datasetDetailEl.querySelectorAll('[data-new-ds-key]');
        const out = {};

        inputs.forEach((el) => {
          const k = el.getAttribute('data-new-ds-key');
          const raw = el.value;

          const fieldDef = DATASET_EDIT_FIELDS.find((x) => x.key === k);
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

          // Handle nested keys like maturity.completeness
          if (k.includes('.')) {
            setNestedValue(out, k, parsedValue);
          } else {
            out[k] = parsedValue;
          }
        });

        const id = String(out.id || '').trim();
        if (!id) {
          alert('Dataset ID is required.');
          return;
        }

        // If ID already exists, confirm
        const exists = getDatasetById(id);
        if (exists) {
          const proceed = confirm(
            `A dataset with ID "${id}" already exists in the catalog. Open an issue anyway?`
          );
          if (!proceed) return;
        }

        // Build the dataset object (remove empty values)
        // 1) Collect new attribute drafts from the UI (so typing is captured)
        const newAttrInputs = els.datasetDetailEl.querySelectorAll('[data-new-attr-idx][data-new-attr-key]');
        newAttrInputs.forEach((el) => {
          const idx = Number(el.getAttribute('data-new-attr-idx'));
          const k = el.getAttribute('data-new-attr-key');
          if (Number.isNaN(idx) || !k) return;
          if (!draft.new_attributes || !draft.new_attributes[idx]) return;
          draft.new_attributes[idx][k] = String(el.value || '');
        });

        // 2) Validate + build new attribute objects
        const newAttributesOut = [];
        const newAttrIds = [];
        let attrValidationFailed = false;
        for (let i = 0; i < (draft.new_attributes || []).length; i++) {
          const a = draft.new_attributes[i];
          const aid = String(a.id || '').trim();
          if (!aid) {
            alert(`New attribute #${i + 1} is missing an Attribute ID.`);
            attrValidationFailed = true;
            break;
          }

          // If it already exists, force user to add it as an existing attribute instead
          if (getAttributeById(aid)) {
            alert(`New attribute ID "${aid}" already exists. Add it as an existing attribute instead.`);
            attrValidationFailed = true;
            break;
          }

          const type = String(a.type || '').trim();
          let values = undefined;
          if (type === 'enumerated') {
            const rawVals = String(a.values_json || '').trim();
            if (rawVals) {
              const parsed = tryParseJson(rawVals);
              if (parsed && parsed.__parse_error__) {
                alert(`Enumerated values JSON parse error for "${aid}":\n${parsed.__parse_error__}`);
                attrValidationFailed = true;
                break;
              }
              if (parsed && !Array.isArray(parsed)) {
                alert(`Enumerated values for "${aid}" must be a JSON array.`);
                attrValidationFailed = true;
                break;
              }
              values = parsed || [];
            } else {
              values = [];
            }
          }

          const attrObj = compactObject({
            id: aid,
            label: String(a.label || '').trim() || undefined,
            type: type || undefined,
            definition: String(a.definition || '').trim() || undefined,
            expected_value: String(a.expected_value || '').trim() || undefined,
            values,
          });

          newAttributesOut.push(attrObj);
          newAttrIds.push(aid);
        }
        if (attrValidationFailed) return;

        // 3) Combine existing + new attribute IDs (de-dupe)
        const existingIds = Array.from(
          new Set((draft.attribute_ids || []).map((x) => String(x || '').trim()).filter(Boolean))
        );
        const combinedAttrIds = Array.from(new Set([...existingIds, ...newAttrIds]));

        const datasetObj = compactObject({
          id,
          title: out.title,
          description: out.description,
          objname: out.objname,
          geometry_type: out.geometry_type,
          agency_owner: out.agency_owner,
          office_owner: out.office_owner,
          contact_email: out.contact_email,
          topics: out.topics || [],
          update_frequency: out.update_frequency,
          development_stage: out.development_stage,
          status: out.status,
          access_level: out.access_level,
          coverage: out.coverage,
          web_mercator_compatible: out.web_mercator_compatible,
          public_web_service: out.public_web_service,
          internal_web_service: out.internal_web_service,
          data_standard: out.data_standard,
          projection: out.projection,
          notes: out.notes,
          maturity: out.maturity || undefined,
          attribute_ids: combinedAttrIds.length ? combinedAttrIds : undefined,
        });

        const issueUrl = buildGithubIssueUrlForNewDataset(datasetObj, newAttributesOut);

        // Return UI to normal dataset view immediately
        goBackToLastDatasetOrList();

        const w = window.open(issueUrl, '_blank', 'noopener');
        if (!w) alert('Popup blocked — please allow popups to open the GitHub Issue.');
      });
    }
  }


  export function renderAttributeEditForm(attrId) {
    if (!els.attributeDetailEl) return;

    const attribute = getAttributeById(attrId);
    if (!attribute) return;

    const original = deepClone(attribute);
    const draft = deepClone(attribute);
    const datasets = getDatasetsForAttribute(attrId) || [];

    let html = '';

    html += `
    <nav class="breadcrumb">
      <button type="button" class="breadcrumb-root" data-breadcrumb="attributes">Attributes</button>
      <span class="breadcrumb-separator">/</span>
      <span class="breadcrumb-current">${escapeHtml(attribute.id)}</span>
    </nav>
  `;

    html += `<h2>Editing: ${escapeHtml(attribute.id)} – ${escapeHtml(attribute.label || '')}</h2>`;

    html += `<div class="card card-attribute-meta" id="attributeEditCard">`;

    html += `<div class="dataset-edit-actions">
      <button type="button" class="btn" data-edit-attr-cancel>Cancel</button>
      <button type="button" class="btn primary" data-edit-attr-submit>Submit suggestion</button>
    </div>`;

    ATTRIBUTE_EDIT_FIELDS.forEach((f) => {
      let val = draft[f.key];

      // For enumerated values, we edit as JSON text
      if (f.type === 'json') {
        val = val === undefined ? '' : JSON.stringify(val, null, 2);
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <textarea class="dataset-edit-input" data-edit-attr-key="${escapeHtml(f.key)}">${escapeHtml(
          val
        )}</textarea>
        </div>
      `;
        return;
      }

      if (f.type === 'textarea') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <textarea class="dataset-edit-input" data-edit-attr-key="${escapeHtml(f.key)}">${escapeHtml(
          val || ''
        )}</textarea>
        </div>
      `;
        return;
      }

      html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
        <input class="dataset-edit-input" type="text" data-edit-attr-key="${escapeHtml(
        f.key
      )}" value="${escapeHtml(val === undefined ? '' : String(val))}" />
      </div>
    `;
    });

    html += `</div>`;

    // Keep "Allowed values" preview if it exists (optional but nice)
    if (attribute.type === 'enumerated' && Array.isArray(attribute.values) && attribute.values.length) {
      html += '<div class="card card-enumerated">';
      html += '<h3>Current allowed values (read-only preview)</h3>';
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

    // Keep datasets list unchanged (read-only), like your normal view
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

    els.attributeDetailEl.innerHTML = html;
    els.attributeDetailEl.classList.remove('hidden');

    // Animate ONLY when entering edit mode (not when browsing existing attributes)
    staggerCards(els.attributeDetailEl);
    animatePanel(els.attributeDetailEl);

    // Breadcrumb root
    const rootBtn = els.attributeDetailEl.querySelector('button[data-breadcrumb="attributes"]');
    if (rootBtn) rootBtn.addEventListener('click', showAttributesView);

    // Dataset navigation still works
    const dsButtons = els.attributeDetailEl.querySelectorAll('button[data-dataset-id]');
    dsButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const dsId = btn.getAttribute('data-dataset-id');
        showDatasetsView();
        if (_renderDatasetDetail) _renderDatasetDetail(dsId);
      });
    });

    // Cancel -> normal view
    const cancelBtn = els.attributeDetailEl.querySelector('button[data-edit-attr-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { if (_renderAttributeDetail) _renderAttributeDetail(attrId); });

    // Submit -> collect, validate JSON for values, diff, open issue, return to normal view
    const submitBtn = els.attributeDetailEl.querySelector('button[data-edit-attr-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        let hadError = false;
        const inputs = els.attributeDetailEl.querySelectorAll('[data-edit-attr-key]');
        inputs.forEach((el) => {
          const k = el.getAttribute('data-edit-attr-key');
          const raw = el.value;

          const def = ATTRIBUTE_EDIT_FIELDS.find((x) => x.key === k);
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

        // return UI to normal view immediately
        if (_renderAttributeDetail) _renderAttributeDetail(attrId);

        window.open(issueUrl, '_blank', 'noopener');
      });
    }
  }
