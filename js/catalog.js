// ====== CATALOG MODULE (shared loader + indexes) ======
import { CATALOG_URL, GITHUB_NEW_ISSUE_BASE, WORKER_BASE_URL } from './config.js';

let cache = null;
let indexesBuilt = false;
let attributeById = {};
let datasetById = {};
let datasetsByAttributeId = {};

export async function loadCatalog() {
  if (cache) return cache;
  const resp = await fetch(CATALOG_URL);
  if (!resp.ok) {
    throw new Error(`Failed to load catalog.json: ${resp.status}`);
  }
  cache = await resp.json();

  // Merge R2-stored admin overrides on top of the base catalog
  await mergeOverrides();

  buildIndexes();
  return cache;
}

/** Fetch catalog-overrides.json from Worker and merge into cached catalog. */
async function mergeOverrides() {
  if (!WORKER_BASE_URL || !cache) return;
  try {
    const workerBase = WORKER_BASE_URL.replace(/\/+$/, '');
    const resp = await fetch(`${workerBase}/catalog/overrides.json`);
    if (!resp.ok) return; // 404 = no overrides yet, that's fine
    const overrides = await resp.json();
    if (!overrides || typeof overrides !== 'object') return;

    const datasets = cache.datasets || [];
    for (const ds of datasets) {
      const patch = overrides[ds.id];
      if (!patch || typeof patch !== 'object') continue;
      for (const [k, v] of Object.entries(patch)) {
        ds[k] = v;
      }
    }
  } catch (_) {
    // Silently ignore — overrides are optional
  }
}

/**
 * Apply a local patch to a dataset in-memory (after saving to Worker).
 * Updates the cached dataset object so the UI reflects changes immediately
 * without a full page reload.
 */
export function applyLocalOverrides(datasetId, fields) {
  const ds = datasetById[datasetId];
  if (!ds) return;
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') {
      delete ds[k];
    } else {
      ds[k] = v;
    }
  }
}

function buildIndexes() {
  if (!cache || indexesBuilt) return;

  attributeById = {};
  datasetById = {};
  datasetsByAttributeId = {};

  // Index attributes
  (cache.attributes || []).forEach((attr) => {
    if (attr.id) attributeById[attr.id] = attr;
  });

  // Index datasets + reverse index of attribute -> datasets
  (cache.datasets || []).forEach((ds) => {
    if (ds.id) datasetById[ds.id] = ds;

    (ds.attribute_ids || []).forEach((attrId) => {
      if (!datasetsByAttributeId[attrId]) datasetsByAttributeId[attrId] = [];
      datasetsByAttributeId[attrId].push(ds);
    });
  });

  indexesBuilt = true;
}

export function getAttributeById(id) {
  return attributeById[id] || null;
}

export function getDatasetById(id) {
  return datasetById[id] || null;
}

export function getAttributesForDataset(dataset) {
  if (!dataset || !dataset.attribute_ids) return [];
  return dataset.attribute_ids.map((id) => attributeById[id]).filter(Boolean);
}

export function getDatasetsForAttribute(attrId) {
  return datasetsByAttributeId[attrId] || [];
}


