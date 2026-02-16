// ====== CATALOG MODULE (shared loader + indexes) ======
import { CATALOG_URL, GITHUB_NEW_ISSUE_BASE } from './config.js';

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
  buildIndexes();
  return cache;
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


