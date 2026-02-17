// app.js — Entry point. Wires up all modules, loads data, registers callbacks.

import { state, els, initElements } from './state.js';
import { loadCatalog } from './catalog.js';
import { renderDashboard, registerDashboardCallbacks } from './dashboard.js';
import { renderDatasetList, renderAttributeList, registerListCallbacks } from './lists.js';
import { renderFilterPanel, registerFilterCallbacks, initFilterToggle } from './filters.js';
import { renderDatasetDetail, renderInlineAttributeDetail, renderAttributeDetail } from './detail.js';
import { renderNewDatasetRequestForm } from './new-dataset-form.js';
import { renderNewAttributeCreateForm } from './forms.js';
import { showDashboardView, showDatasetsView, showAttributesView, registerNavigationCallbacks } from './navigation.js';

/** Simple debounce helper */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

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

  // ── Show loading state ──
  if (els.dashboardContentEl) {
    els.dashboardContentEl.innerHTML = '<p class="loading-message">Loading catalog data&hellip;</p>';
  }
  if (els.datasetListEl) {
    els.datasetListEl.innerHTML = '<p class="loading-message">Loading&hellip;</p>';
  }
  if (els.attributeListEl) {
    els.attributeListEl.innerHTML = '<p class="loading-message">Loading&hellip;</p>';
  }

  // ── Load catalog data ──
  try {
    const catalogData = await loadCatalog();
    state.catalogData = catalogData;
    state.allDatasets = catalogData.datasets || [];
    state.allAttributes = catalogData.attributes || [];
  } catch (err) {
    console.error('Failed to load catalog.json:', err);
    const msg = 'Error loading catalog. Please try refreshing the page.';
    if (els.dashboardContentEl) els.dashboardContentEl.innerHTML = `<p class="error-message">${msg}</p>`;
    if (els.datasetListEl) els.datasetListEl.innerHTML = `<p class="error-message">${msg}</p>`;
    if (els.attributeListEl) els.attributeListEl.innerHTML = `<p class="error-message">${msg}</p>`;
    return;
  }

  // ── New dataset / attribute buttons ──
  const newDatasetBtn = document.getElementById('newDatasetBtn');
  if (newDatasetBtn) {
    newDatasetBtn.addEventListener('click', () => {
      showDatasetsView();
      renderNewDatasetRequestForm();
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

  // ── Filter panel toggle ──
  initFilterToggle();

  // ── Tab switching ──
  if (els.dashboardTabBtn) els.dashboardTabBtn.addEventListener('click', showDashboardView);
  if (els.datasetsTabBtn) els.datasetsTabBtn.addEventListener('click', showDatasetsView);
  if (els.attributesTabBtn) els.attributesTabBtn.addEventListener('click', showAttributesView);

  // ── Search inputs (debounced) ──
  if (els.datasetSearchInput) {
    els.datasetSearchInput.addEventListener('input', debounce(() => {
      renderDatasetList(els.datasetSearchInput.value);
    }, 200));
  }
  if (els.attributeSearchInput) {
    els.attributeSearchInput.addEventListener('input', debounce(() => {
      renderAttributeList(els.attributeSearchInput.value);
    }, 200));
  }

  // ── Initial render ──
  renderDatasetList();
  renderAttributeList();

  // ── Hash-based deep linking ──
  function navigateFromHash() {
    const hash = window.location.hash;
    const match = hash.match(/^#dataset\/(.+)$/);
    if (match) {
      const dsId = decodeURIComponent(match[1]);
      if (dsId && state.allDatasets.some(ds => ds.id === dsId)) {
        showDatasetsView();
        renderDatasetDetail(dsId);
        return true;
      }
    }
    return false;
  }

  // On initial load, check hash first; fall back to dashboard
  if (!navigateFromHash()) {
    renderDashboard();
    // Pre-select first dataset so clicking Datasets tab shows detail immediately
    if (state.allDatasets.length) {
      state.lastSelectedDatasetId = state.allDatasets[0].id;
    }
  }

  // Listen for hash changes (back/forward, manual URL edits)
  window.addEventListener('hashchange', () => navigateFromHash());
});
