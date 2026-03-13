// field-explorer.js — Aggregates field/attribute data across all datasets' service-info files.
// Provides a cross-dataset field dictionary for the Attributes tab.

import { state } from './state.js';
import { areDistinctCountsSuspect } from './arcgis-preview.js';

let fieldIndex = null;  // Map<fieldName, FieldInfo>
let fieldList  = [];    // Sorted array of field entries for rendering
let loading    = false;
let loaded     = false;
let loadCallbacks = [];
let generatedTimestamp = null; // ISO timestamp from field-index.json

export function getFieldIndexGenerated() { return generatedTimestamp; }

/**
 * FieldInfo shape:
 * {
 *   name:          string,
 *   aliases:       string[],          // unique aliases across datasets
 *   primaryAlias:  string,            // most common alias
 *   types:         string[],          // unique Esri field types
 *   primaryType:   string,            // most common type
 *   datasetCount:  number,
 *   avgNullPct:    number | null,
 *   hasDomain:     boolean,
 *   datasets: [{
 *     datasetId, datasetTitle, type, alias, nullPct, distinctCount, hasDomain, domainValues
 *   }]
 * }
 */

export function isFieldIndexLoaded() { return loaded; }
export function isFieldIndexLoading() { return loading; }
export function getFieldList() { return fieldList; }

export function getFieldInfo(fieldName) {
  if (!fieldIndex) return null;
  return fieldIndex.get(fieldName) || fieldIndex.get(fieldName.toUpperCase()) || null;
}

export function searchFields(text) {
  if (!fieldList.length) return [];
  const ft = text.trim().toLowerCase();
  if (!ft) return fieldList;
  return fieldList.filter(f => {
    const haystack = [f.name, f.primaryAlias, ...f.aliases].join(' ').toLowerCase();
    return haystack.includes(ft);
  });
}

/**
 * Load field data. Tries data/field-index.json first (fast pre-built path),
 * falls back to loading individual service-info files.
 * Calls onProgress(loaded, total) during the slow path.
 * Returns a promise that resolves with the field list.
 */
export async function loadFieldData(onProgress) {
  if (loaded) return fieldList;
  if (loading) {
    return new Promise(resolve => loadCallbacks.push(resolve));
  }
  loading = true;

  // Fast path: try pre-built field index
  try {
    const resp = await fetch('data/field-index.json');
    if (resp.ok) {
      const data = await resp.json();
      generatedTimestamp = data.generated || null;
      buildIndexFromPrebuilt(data);
      loaded = true;
      loading = false;
      loadCallbacks.forEach(cb => cb(fieldList));
      loadCallbacks = [];
      return fieldList;
    }
  } catch (_) { /* fall through to slow path */ }

  // Slow path: load individual service-info files for each dataset
  const datasets = state.allDatasets || [];
  const datasetIds = datasets.filter(d => d.public_web_service).map(d => d.id);
  let completed = 0;
  const total = datasetIds.length;
  const allFieldData = [];

  const CONCURRENCY = 8;
  let idx = 0;

  async function worker() {
    while (idx < datasetIds.length) {
      const i = idx++;
      const dsId = datasetIds[i];
      try {
        const resp = await fetch(`data/service-info/${dsId}.json`);
        if (resp.ok) {
          const info = await resp.json();
          allFieldData.push({ datasetId: dsId, info });
        }
      } catch (_) { /* skip missing files */ }
      completed++;
      if (onProgress) onProgress(completed, total);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  buildIndexFromServiceInfoFiles(allFieldData);
  loaded = true;
  loading = false;
  loadCallbacks.forEach(cb => cb(fieldList));
  loadCallbacks = [];
  return fieldList;
}

// ── Build from pre-generated field-index.json ──

function buildIndexFromPrebuilt(data) {
  fieldIndex = new Map();
  fieldList = [];

  (data.fields || []).forEach(f => {
    fieldIndex.set(f.name, f);
    fieldIndex.set(f.name.toUpperCase(), f);
    fieldList.push(f);
  });

  fieldList.sort((a, b) => b.datasetCount - a.datasetCount || a.name.localeCompare(b.name));
}

// ── Build from individual service-info files ──

function buildIndexFromServiceInfoFiles(allData) {
  const fieldMap = {};

  // Dataset id → metadata lookup
  const dsById = {};
  (state.allDatasets || []).forEach(d => { dsById[d.id] = d; });

  allData.forEach(({ datasetId, info }) => {
    const ds = dsById[datasetId];
    const dsTitle = ds ? (ds._layer_name || ds.title || ds.id) : datasetId;

    const fields = info.fields || [];
    const fStats = info.fieldStats || [];
    const statsMap = {};
    fStats.forEach(s => { statsMap[s.name] = s; });

    const recordCount = info.metadata?.recordCount || 0;
    const suspectDistinct = areDistinctCountsSuspect(fStats, recordCount);

    fields.forEach(f => {
      const name = f.name;
      if (!fieldMap[name]) {
        fieldMap[name] = {
          name,
          _aliasCounts: {},
          _typeCounts: {},
          _nullPcts: [],
          _hasDomain: false,
          datasetCount: 0,
          datasets: [],
        };
      }

      const entry = fieldMap[name];
      entry.datasetCount++;

      const alias = f.alias || name;
      entry._aliasCounts[alias] = (entry._aliasCounts[alias] || 0) + 1;

      const type = f.type || 'unknown';
      entry._typeCounts[type] = (entry._typeCounts[type] || 0) + 1;

      const stats = statsMap[name];
      const nullPct = stats ? stats.nullPct : null;
      const rawDc = stats ? stats.distinctCount : null;
      const distinctCount = (suspectDistinct && rawDc === recordCount) ? null : rawDc;
      const hasDomain = !!(f.domain || (stats && stats.hasDomain));

      if (hasDomain) entry._hasDomain = true;
      if (nullPct !== null && nullPct !== undefined) entry._nullPcts.push(nullPct);

      // Collect domain coded values (if available)
      let domainValues = null;
      if (f.domain && f.domain.type === 'codedValue' && f.domain.codedValues) {
        domainValues = f.domain.codedValues;
      } else if (f.domain && f.domain.codedValueCount) {
        domainValues = f.domain.codedValueCount + ' coded values';
      }

      entry.datasets.push({
        datasetId,
        datasetTitle: dsTitle,
        type,
        alias,
        nullPct,
        distinctCount,
        hasDomain,
        domainValues,
      });
    });
  });

  // Finalize each field entry
  fieldIndex = new Map();
  fieldList = [];

  Object.values(fieldMap).forEach(entry => {
    // Primary alias (most common)
    const aliasSorted = Object.entries(entry._aliasCounts).sort((a, b) => b[1] - a[1]);
    entry.primaryAlias = aliasSorted.length ? aliasSorted[0][0] : entry.name;
    entry.aliases = [...new Set(Object.keys(entry._aliasCounts))];

    // Primary type (most common)
    const typeSorted = Object.entries(entry._typeCounts).sort((a, b) => b[1] - a[1]);
    entry.primaryType = typeSorted.length ? typeSorted[0][0] : 'unknown';
    entry.types = [...new Set(Object.keys(entry._typeCounts))];

    // Average null percentage
    entry.avgNullPct = entry._nullPcts.length
      ? Math.round(entry._nullPcts.reduce((a, b) => a + b, 0) / entry._nullPcts.length * 10) / 10
      : null;

    entry.hasDomain = entry._hasDomain;

    // Clean up internal fields
    delete entry._aliasCounts;
    delete entry._typeCounts;
    delete entry._nullPcts;
    delete entry._hasDomain;

    // Sort datasets alphabetically
    entry.datasets.sort((a, b) => a.datasetTitle.localeCompare(b.datasetTitle));

    fieldIndex.set(entry.name, entry);
    fieldIndex.set(entry.name.toUpperCase(), entry);
    fieldList.push(entry);
  });

  // Sort: most-used first, then alphabetically
  fieldList.sort((a, b) => b.datasetCount - a.datasetCount || a.name.localeCompare(b.name));
}

// ── Display helpers ──

const ESRI_TYPE_SHORT = {
  'esriFieldTypeOID':          'OID',
  'esriFieldTypeGlobalID':     'GlobalID',
  'esriFieldTypeString':       'String',
  'esriFieldTypeInteger':      'Integer',
  'esriFieldTypeSmallInteger': 'SmallInt',
  'esriFieldTypeDouble':       'Double',
  'esriFieldTypeSingle':       'Single',
  'esriFieldTypeDate':         'Date',
  'esriFieldTypeGUID':         'GUID',
  'esriFieldTypeXML':          'XML',
  'esriFieldTypeBlob':         'Blob',
  'esriFieldTypeRaster':       'Raster',
  'esriFieldTypeGeometry':     'Geometry',
};

export function shortTypeName(esriType) {
  return ESRI_TYPE_SHORT[esriType] || esriType || '?';
}

const TYPE_COLORS = {
  'String':   'rgba(91,163,245,0.7)',
  'Integer':  'rgba(16,185,129,0.7)',
  'SmallInt': 'rgba(16,185,129,0.6)',
  'Double':   'rgba(52,211,153,0.7)',
  'Single':   'rgba(52,211,153,0.6)',
  'Date':     'rgba(192,132,252,0.7)',
  'OID':      'rgba(107,114,128,0.5)',
  'GlobalID': 'rgba(107,114,128,0.5)',
  'GUID':     'rgba(107,114,128,0.5)',
};

export function typeColor(shortType) {
  return TYPE_COLORS[shortType] || 'rgba(255,255,255,0.15)';
}
