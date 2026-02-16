export const state = {
  allDatasets: [],
  allAttributes: [],
  catalogData: null,
  lastSelectedDatasetId: null,
};

export const els = {
  dashboardTabBtn: null,
  datasetsTabBtn: null,
  attributesTabBtn: null,
  dashboardView: null,
  dashboardContentEl: null,
  datasetsView: null,
  attributesView: null,
  datasetSearchInput: null,
  attributeSearchInput: null,
  datasetListEl: null,
  attributeListEl: null,
  datasetDetailEl: null,
  attributeDetailEl: null,
  datasetFiltersEl: null,
  activeFilterChipsEl: null,
};

export function initElements() {
  els.dashboardTabBtn = document.getElementById('dashboardTab');
  els.datasetsTabBtn = document.getElementById('datasetsTab');
  els.attributesTabBtn = document.getElementById('attributesTab');
  els.dashboardView = document.getElementById('dashboardView');
  els.dashboardContentEl = document.getElementById('dashboardContent');
  els.datasetsView = document.getElementById('datasetsView');
  els.attributesView = document.getElementById('attributesView');
  els.datasetSearchInput = document.getElementById('datasetSearchInput');
  els.attributeSearchInput = document.getElementById('attributeSearchInput');
  els.datasetListEl = document.getElementById('datasetList');
  els.attributeListEl = document.getElementById('attributeList');
  els.datasetDetailEl = document.getElementById('datasetDetail');
  els.attributeDetailEl = document.getElementById('attributeDetail');
  els.datasetFiltersEl = document.getElementById('datasetFilters');
  els.activeFilterChipsEl = document.getElementById('activeFilterChips');
}
