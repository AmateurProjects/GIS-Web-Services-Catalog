// app.js — Entry point. Wires up all modules, loads data, registers callbacks.

import { state, els, initElements } from './state.js';
import { loadCatalog } from './catalog.js';
import { renderDashboard, registerDashboardCallbacks } from './dashboard.js';
import { renderDatasetList, renderAttributeList, registerListCallbacks } from './lists.js';
import { renderFilterPanel, registerFilterCallbacks } from './filters.js';
import { renderDatasetDetail, renderInlineAttributeDetail, renderAttributeDetail, registerDetailCallbacks } from './detail.js';
import { renderDatasetEditForm, renderNewAttributeCreateForm, renderNewDatasetCreateForm, renderAttributeEditForm, registerFormCallbacks } from './forms.js';
import { showDashboardView, showDatasetsView, showAttributesView, registerNavigationCallbacks } from './navigation.js';

document.addEventListener('DOMContentLoaded', async () => {
  // ── Populate DOM element references ──
  initElements();

  // ── Register lazy callbacks to break circular module deps ──
  registerNavigationCallbacks({
    renderDashboard,
    renderFilterPanel,
    renderDatasetDetail,
    renderAttributeDetail,
  });

  registerFilterCallbacks({
    renderDatasetList,
  });

  registerListCallbacks({
    renderDatasetDetail,
    renderAttributeDetail,
  });

  registerDashboardCallbacks({
    renderDatasetDetail,
  });

  registerDetailCallbacks({
    renderDatasetEditForm,
    renderAttributeEditForm,
  });

  registerFormCallbacks({
    renderDatasetDetail,
    renderAttributeDetail,
    renderInlineAttributeDetail,
  });

  // ── Load catalog data ──
  try {
    const catalogData = await loadCatalog();
    state.catalogData = catalogData;
    state.allDatasets = catalogData.datasets || [];
    state.allAttributes = catalogData.attributes || [];
  } catch (err) {
    console.error('Failed to load catalog.json:', err);
    if (els.datasetListEl) els.datasetListEl.textContent = 'Error loading catalog.';
    if (els.attributeListEl) els.attributeListEl.textContent = 'Error loading catalog.';
    return;
  }

  // ── New dataset / attribute buttons ──
  const newDatasetBtn = document.getElementById('newDatasetBtn');
  if (newDatasetBtn) {
    newDatasetBtn.addEventListener('click', () => {
      showDatasetsView();
      renderNewDatasetCreateForm();
    });
  }

  const newAttributeBtn = document.getElementById('newAttributeBtn');
  if (newAttributeBtn) {
    newAttributeBtn.addEventListener('click', () => {
      showAttributesView();
      renderNewAttributeCreateForm();
    });
  }

  // ── Collapsible text toggle (delegated) ──
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-collapse]');
    if (!btn) return;
    const container = btn.closest('.collapsible-text-container');
    if (!container) return;
    const textEl = container.querySelector('.collapsible-text');
    if (!textEl) return;
    const isCollapsed = textEl.classList.contains('is-collapsed');
    if (isCollapsed) {
      textEl.classList.remove('is-collapsed');
      btn.textContent = 'Show less';
    } else {
      textEl.classList.add('is-collapsed');
      btn.textContent = 'Show more';
    }
  });

  // ── Tab switching ──
  if (els.dashboardTabBtn) els.dashboardTabBtn.addEventListener('click', showDashboardView);
  if (els.datasetsTabBtn) els.datasetsTabBtn.addEventListener('click', showDatasetsView);
  if (els.attributesTabBtn) els.attributesTabBtn.addEventListener('click', showAttributesView);

  // ── Search inputs ──
  if (els.datasetSearchInput) {
    els.datasetSearchInput.addEventListener('input', () => renderDatasetList(els.datasetSearchInput.value));
  }
  if (els.attributeSearchInput) {
    els.attributeSearchInput.addEventListener('input', () => renderAttributeList(els.attributeSearchInput.value));
  }

  // ── Initial render ──
  renderDatasetList();
  renderAttributeList();
  renderDashboard();

  // Pre-select first dataset so clicking Datasets tab shows detail immediately
  if (state.allDatasets.length) {
    state.lastSelectedDatasetId = state.allDatasets[0].id;
  }
});
