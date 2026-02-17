// lists.js — Dataset and attribute list rendering

import { state, els } from './state.js';
import { escapeHtml } from './utils.js';
import { getGeometryIconHTML } from './geometry-icons.js';
import { setActiveListButton } from './ui-fx.js';
import { getFilteredDatasets, hasAnyFilter } from './filters.js';
import { showDatasetsView, showAttributesView } from './navigation.js';
import { fetchPendingDatasetRequests, parseRequestedDatasetName, parseRequestedDescription } from './github-api.js';

// Lazy references to detail renderers — set by app.js to avoid circular import at eval time
let _renderDatasetDetail = null;
let _renderAttributeDetail = null;

export function registerListCallbacks({ renderDatasetDetail, renderAttributeDetail }) {
  _renderDatasetDetail = renderDatasetDetail;
  _renderAttributeDetail = renderAttributeDetail;
}

function extractServiceNameFromUrl(url) {
  if (!url) return 'Unknown Service';
  // Example: https://gis.blm.gov/arcgis/rest/services/admin_boundaries/BLM_Natl_AdminUnit_Generalized/FeatureServer
  // We want: "BLM_Natl_AdminUnit_Generalized"
  const match = url.match(/\/rest\/services\/(?:[^\/]+\/)?([^\/]+)\/(?:MapServer|FeatureServer|ImageServer)/i);
  if (match && match[1]) {
    // Replace underscores with spaces for readability
    return match[1].replace(/_/g, ' ');
  }
  // Fallback: try to get the last meaningful path segment
  const parts = url.split('/').filter(Boolean);
  const typeKeywords = ['MapServer', 'FeatureServer', 'ImageServer', 'rest', 'services', 'arcgis'];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!typeKeywords.some(k => parts[i].toLowerCase() === k.toLowerCase())) {
      return parts[i].replace(/_/g, ' ');
    }
  }
  return 'Service';
}

export function renderDatasetList(filterText) {
  if (!els.datasetListEl) return;
  const ft = filterText !== undefined ? filterText : (els.datasetSearchInput ? els.datasetSearchInput.value : '');
  const filtered = getFilteredDatasets(ft);

  // Show result count when filters are active
  let countHtml = '';
  if (hasAnyFilter() || String(ft).trim()) {
    countHtml = `<div class="filter-result-count">Showing <strong>${filtered.length}</strong> of ${state.allDatasets.length} datasets</div>`;
  }

  if (!filtered.length) {
    els.datasetListEl.innerHTML = countHtml + '<p style="padding:0.5rem;color:var(--text-muted);">No datasets match the current filters.</p>';
    return;
  }

  // Group datasets by parent service
  const serviceGroups = new Map();
  const standaloneDatasets = [];

  filtered.forEach((ds) => {
    if (ds._parent_service) {
      if (!serviceGroups.has(ds._parent_service)) {
        const serviceName = extractServiceNameFromUrl(ds._parent_service);
        serviceGroups.set(ds._parent_service, {
          label: serviceName,
          url: ds._parent_service,
          datasets: []
        });
      }
      serviceGroups.get(ds._parent_service).datasets.push(ds);
    } else {
      standaloneDatasets.push(ds);
    }
  });

  // Sort sublayers within each group by layer ID
  serviceGroups.forEach((group) => {
    group.datasets.sort((a, b) => (a._layer_id ?? 999) - (b._layer_id ?? 999));
  });

  const container = document.createElement('div');

  // Render grouped services first
  serviceGroups.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'service-tree-group';

    const hasSelectedChild = group.datasets.some(ds => ds.id === state.lastSelectedDatasetId);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'service-tree-header' + (hasSelectedChild ? ' is-expanded' : '');
    header.innerHTML = `
      <span class="service-tree-toggle">▶</span>
      <span class="service-tree-label" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</span>
      <span class="service-tree-count">${group.datasets.length} layers</span>
    `;

    const childrenEl = document.createElement('ul');
    childrenEl.className = 'service-tree-children' + (hasSelectedChild ? ' is-open' : '');

    header.addEventListener('click', () => {
      header.classList.toggle('is-expanded');
      childrenEl.classList.toggle('is-open');
    });

    group.datasets.forEach((ds) => {
      const li = document.createElement('li');
      li.className = 'list-item dataset-item';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-item-button';
      btn.setAttribute('data-ds-id', ds.id);

      const geomIconHtml = getGeometryIconHTML(ds.geometry_type || '', 'geom-icon-list');
      const layerName = ds._layer_name || ds.title || ds.id;
      const layerId = ds._layer_id !== undefined ? ds._layer_id : '';

      btn.innerHTML = `
        ${geomIconHtml}
        <span class="list-item-label">${escapeHtml(layerName)}</span>
        ${layerId !== '' ? `<span class="sublayer-id">/${layerId}</span>` : ''}
      `;

      btn.addEventListener('click', () => {
        showDatasetsView();
        if (_renderDatasetDetail) _renderDatasetDetail(ds.id);
      });

      li.appendChild(btn);
      childrenEl.appendChild(li);
    });

    groupEl.appendChild(header);
    groupEl.appendChild(childrenEl);
    container.appendChild(groupEl);
  });

  // Render standalone datasets
  if (standaloneDatasets.length > 0) {
    const standaloneList = document.createElement('ul');
    standaloneDatasets.forEach((ds) => {
      const li = document.createElement('li');
      li.className = 'list-item dataset-item standalone-dataset';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-item-button';
      btn.setAttribute('data-ds-id', ds.id);

      const geomIconHtml = getGeometryIconHTML(ds.geometry_type || '', 'geom-icon-list');

      btn.innerHTML = `
        ${geomIconHtml}
        <span class="list-item-label">${escapeHtml(ds.title || ds.id)}</span>
      `;

      btn.addEventListener('click', () => {
        showDatasetsView();
        if (_renderDatasetDetail) _renderDatasetDetail(ds.id);
      });

      li.appendChild(btn);
      standaloneList.appendChild(li);
    });
    container.appendChild(standaloneList);
  }

  els.datasetListEl.innerHTML = '';
  if (countHtml) {
    const countDiv = document.createElement('div');
    countDiv.innerHTML = countHtml;
    els.datasetListEl.appendChild(countDiv.firstElementChild);
  }
  els.datasetListEl.appendChild(container);

  // keep active highlight in sync after re-render
  setActiveListButton(els.datasetListEl, (b) => b.getAttribute('data-ds-id') === state.lastSelectedDatasetId);

  // Append pending requests section (async)
  appendPendingRequestsToList(ft);
}

/** Append pending dataset requests at the bottom of the layer list. */
async function appendPendingRequestsToList(filterText) {
  if (!els.datasetListEl) return;

  // Remove any existing pending section (from a previous render)
  const existing = els.datasetListEl.querySelector('.pending-requests-sidebar');
  if (existing) existing.remove();

  try {
    const requests = await fetchPendingDatasetRequests();
    if (!requests || !requests.length) return;

    // Filter by search text if present
    const ft = String(filterText || '').trim().toLowerCase();
    const filtered = ft
      ? requests.filter(req => {
          const name = parseRequestedDatasetName(req.title).toLowerCase();
          const desc = parseRequestedDescription(req.body).toLowerCase();
          return name.includes(ft) || desc.includes(ft);
        })
      : requests;

    if (!filtered.length) return;

    const section = document.createElement('div');
    section.className = 'pending-requests-sidebar';
    section.innerHTML = `
      <div class="pending-sidebar-header">
        <span class="pending-sidebar-icon">&#128203;</span>
        Pending Requests <span class="pending-sidebar-count">${filtered.length}</span>
      </div>
    `;

    const list = document.createElement('ul');
    list.className = 'pending-requests-list pending-sidebar-list';

    filtered.forEach(req => {
      const name = parseRequestedDatasetName(req.title);
      const desc = parseRequestedDescription(req.body);
      const li = document.createElement('li');
      li.className = 'pending-request-item';
      li.innerHTML = `
        <a href="${escapeHtml(req.url)}" target="_blank" rel="noopener" class="pending-request-link" title="Open request on GitHub">
          <strong>${escapeHtml(name)}</strong>

        </a>
      `;
      list.appendChild(li);
    });

    section.appendChild(list);
    els.datasetListEl.appendChild(section);
  } catch (err) {
    console.warn('Failed to load pending requests for sidebar', err);
  }
}

export function renderAttributeList(filterText = '') {
  if (!els.attributeListEl) return;
  const ft = filterText.trim().toLowerCase();

  const filtered = !ft
    ? state.allAttributes
    : state.allAttributes.filter((attr) => {
      const haystack = [attr.id, attr.label, attr.definition].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(ft);
    });

  if (!filtered.length) {
    els.attributeListEl.innerHTML = '<p>No attributes found.</p>';
    return;
  }

  const list = document.createElement('ul');
  filtered.forEach((attr) => {
    const li = document.createElement('li');
    li.className = 'list-item attribute-item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'list-item-button';
    btn.setAttribute('data-attr-id', attr.id);
    btn.textContent = `${attr.id} – ${attr.label || ''}`;

    btn.addEventListener('click', () => {
      showAttributesView();
      if (_renderAttributeDetail) _renderAttributeDetail(attr.id);
    });

    li.appendChild(btn);
    list.appendChild(li);
  });

  els.attributeListEl.innerHTML = '';
  els.attributeListEl.appendChild(list);
}
