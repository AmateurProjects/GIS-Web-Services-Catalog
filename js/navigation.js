// navigation.js — Tab switching and back-navigation helpers

import { state, els } from './state.js';
import { getDatasetById } from './catalog.js';
import { getCurrentMapView } from './arcgis-preview.js';

// Lazy imports to break circular dependencies — these modules import from navigation.js too.
// ES modules handle this fine because all calls are from event handlers, not at import time.
let _renderDashboard = null;
let _renderFilterPanel = null;
let _renderDatasetDetail = null;
let _renderAttributeDetail = null;

/**
 * Register render callbacks. Called once from app.js after all modules are loaded.
 * This avoids circular import issues at module evaluation time.
 */
export function registerNavigationCallbacks({ renderDashboard, renderFilterPanel, renderDatasetDetail, renderAttributeDetail }) {
  _renderDashboard = renderDashboard;
  _renderFilterPanel = renderFilterPanel;
  _renderDatasetDetail = renderDatasetDetail;
  _renderAttributeDetail = renderAttributeDetail;
}

export function hideAllViews() {
  if (els.dashboardView) els.dashboardView.classList.add('hidden');
  if (els.datasetsView) els.datasetsView.classList.add('hidden');
  if (els.attributesView) els.attributesView.classList.add('hidden');
  if (els.dashboardTabBtn) els.dashboardTabBtn.classList.remove('active');
  if (els.datasetsTabBtn) els.datasetsTabBtn.classList.remove('active');
  if (els.attributesTabBtn) els.attributesTabBtn.classList.remove('active');
}

/** Destroy the ArcGIS MapView if it exists, to free WebGL resources */
function cleanupMapView() {
  const view = getCurrentMapView();
  if (view) {
    try { view.destroy(); } catch (_) { /* ignore */ }
  }
}

export function showDashboardView() {
  cleanupMapView();
  hideAllViews();
  if (els.dashboardView) els.dashboardView.classList.remove('hidden');
  els.dashboardTabBtn && els.dashboardTabBtn.classList.add('active');
  if (_renderDashboard) _renderDashboard();
}

export function showDatasetsView() {
  hideAllViews();
  if (els.datasetsView) els.datasetsView.classList.remove('hidden');
  if (els.datasetsTabBtn) els.datasetsTabBtn.classList.add('active');
  // Render filter panel when switching to datasets
  if (_renderFilterPanel) _renderFilterPanel();
  // Lazy-render dataset detail on first switch to Datasets tab
  if (state.lastSelectedDatasetId && els.datasetDetailEl && els.datasetDetailEl.classList.contains('hidden')) {
    if (_renderDatasetDetail) _renderDatasetDetail(state.lastSelectedDatasetId);
  }
}

export function showAttributesView() {
  cleanupMapView();
  hideAllViews();
  if (els.attributesView) els.attributesView.classList.remove('hidden');
  if (els.attributesTabBtn) els.attributesTabBtn.classList.add('active');
}

export function goBackToLastDatasetOrList() {
  showDatasetsView();
  if (state.lastSelectedDatasetId && getDatasetById(state.lastSelectedDatasetId)) {
    if (_renderDatasetDetail) _renderDatasetDetail(state.lastSelectedDatasetId);
    return;
  }
  if (state.allDatasets && state.allDatasets.length) {
    if (_renderDatasetDetail) _renderDatasetDetail(state.allDatasets[0].id);
    return;
  }
  els.datasetDetailEl && els.datasetDetailEl.classList.add('hidden');
}

export function goBackToAttributesListOrFirst() {
  showAttributesView();
  if (state.allAttributes && state.allAttributes.length) {
    if (_renderAttributeDetail) _renderAttributeDetail(state.allAttributes[0].id);
    return;
  }
  els.attributeDetailEl && els.attributeDetailEl.classList.add('hidden');
}
