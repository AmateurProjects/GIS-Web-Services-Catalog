// freshness.js — Multi-signal freshness detection for ArcGIS REST services.
//
// Determines when a web service was last updated using a cascade of signals:
//   1. editingInfo.lastEditDate (layer-level timestamp from ArcGIS Server)
//   2. Editor tracking date fields (MAX query on edit date fields)
//   3. Common date field heuristics (MAX on fields named *EDIT_DATE*, *MODIFY*, etc.)
//   4. Record count delta (compared to stored baseline)
//   5. Service metadata text (regex for "last updated" in descriptions)
//
// Each signal carries a confidence level: high | medium | low | none.

import { normalizeServiceUrl, parseServiceAndLayerId, fetchJsonWithTimeout, fetchServiceJson, fetchLayerJson, isImageService } from './arcgis-preview.js';

/**
 * FreshnessResult shape:
 * {
 *   lastUpdated:   string | null,     // ISO date string or null
 *   signal:        string,            // which detection method found it
 *   confidence:    'high' | 'medium' | 'low' | 'none',
 *   details:       string,            // human-readable explanation
 *   signals:       SignalResult[],    // all signals attempted, for transparency
 *   recordCount:   number | null,     // current record count (for delta tracking)
 * }
 *
 * SignalResult shape:
 * { signal: string, value: string|null, confidence: string, detail: string }
 */

// ── Common date field name patterns (case-insensitive) ──
const DATE_FIELD_PATTERNS = [
  // Editor tracking fields (highest priority)
  /^last_edit(ed)?_date$/i,
  /^edit_date$/i,
  /^edited_date$/i,
  /^last_editor?_date$/i,
  // Modification fields
  /^modif(y|ied)_date$/i,
  /^last_modif(y|ied)$/i,
  /^date_modif(y|ied)$/i,
  /^update_date$/i,
  /^last_update(d)?$/i,
  /^date_updated$/i,
  // Creation fields (fallback — less indicative of "currency")
  /^created?_date$/i,
  /^create_date$/i,
  /^date_created$/i,
  // GDB tracking
  /^gdb_from_date$/i,
  /^sde_state_id$/i,
  // Generic
  /date$/i,
];

// ── Priority scoring for date fields ──
function dateFieldPriority(fieldName) {
  const n = fieldName.toUpperCase();
  if (/LAST.?EDIT/.test(n) || /EDIT.?DATE/.test(n) || /EDITED.?DATE/.test(n)) return 0;
  if (/MODIF/.test(n) || /UPDATE/.test(n)) return 1;
  if (/CREATE/.test(n)) return 2;
  if (/GDB/.test(n)) return 3;
  return 4;
}

// ── Date validation (rejects obvious sentinel/placeholder values) ──
function isValidRealisticDate(date) {
  if (!date || isNaN(date.getTime())) return false;
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // Reject dates more than 1 year in the future
  if (year > currentYear + 1) return false;
  
  // Reject far-future placeholder (year 9999)
  if (year === 9999) return false;
  
  // Reject common database sentinel dates (exactly Jan 1 of these years)
  // These are often default/null values in databases, not real data
  if ((year === 1899 || year === 1900) && month === 0 && day === 1) return false;
  
  // Reject Unix epoch exactly (Jan 1, 1970 00:00:00.000) — uninitialized timestamp
  if (date.getTime() === 0) return false;
  
  return true;
}

/**
 * Run all freshness signals against a service URL.
 * @param {string} rawUrl — ArcGIS REST service URL
 * @param {object} [cachedServiceInfo] — Pre-cached service-info data (avoids re-fetching)
 * @param {number|null} [storedRecordCount] — Previously stored record count (for delta detection)
 * @returns {Promise<FreshnessResult>}
 */
export async function detectFreshness(rawUrl, cachedServiceInfo = null, storedRecordCount = null) {
  const url = normalizeServiceUrl(rawUrl);
  if (!url) {
    return { lastUpdated: null, signal: 'none', confidence: 'none', details: 'No URL provided', signals: [], recordCount: null };
  }

  const parsed = parseServiceAndLayerId(url);
  const serviceUrl = parsed.serviceUrl;
  const _isImageSvc = isImageService(serviceUrl);
  // ImageServer has no sublayers — don't append a layer ID
  const layerId = _isImageSvc ? null : (parsed.isLayerUrl ? parsed.layerId : 0);
  const queryTarget = _isImageSvc ? serviceUrl : (parsed.isLayerUrl ? url : `${serviceUrl}/${layerId}`);

  const signals = [];
  let serviceJson = null;
  let layerJson = null;

  // ── Try to use cached data first ──
  if (cachedServiceInfo && cachedServiceInfo.metadata) {
    serviceJson = cachedServiceInfo.metadata;
    layerJson = cachedServiceInfo.metadata;
  }

  // ── Fetch live metadata if not cached ──
  if (!serviceJson) {
    try {
      serviceJson = await fetchServiceJson(serviceUrl);
    } catch (e) {
      signals.push({ signal: 'service_fetch', value: null, confidence: 'none', detail: `Could not reach service: ${e.message}` });
    }
  }
  if (!layerJson && serviceJson) {
    try {
      layerJson = await fetchLayerJson(serviceUrl, layerId);
    } catch (_) {
      layerJson = serviceJson; // Use service-level metadata
    }
  }

  // ── Signal 1: editingInfo.lastEditDate ──
  const editingInfo = layerJson?.editingInfo || serviceJson?.editingInfo;
  const lastEditDate = editingInfo?.lastEditDate;
  if (lastEditDate && typeof lastEditDate === 'number' && lastEditDate > 0) {
    const d = new Date(lastEditDate);
    if (isValidRealisticDate(d)) {
      signals.push({
        signal: 'editingInfo.lastEditDate',
        value: d.toISOString(),
        confidence: 'high',
        detail: `ArcGIS Server editingInfo.lastEditDate: ${d.toISOString()}`,
      });
    } else {
      signals.push({
        signal: 'editingInfo.lastEditDate',
        value: null,
        confidence: 'none',
        detail: `editingInfo.lastEditDate has unrealistic value (year ${d.getFullYear()})`,
      });
    }
  } else {
    signals.push({
      signal: 'editingInfo.lastEditDate',
      value: null,
      confidence: 'none',
      detail: 'Service does not expose editingInfo.lastEditDate',
    });
  }

  // ── Signal 2: Editor tracking date fields (via MAX stat query) ──
  // Skip for ImageServer — no /query endpoint
  const fields = cachedServiceInfo?.fields || layerJson?.fields || [];
  const editFieldsInfo = layerJson?.editFieldsInfo || cachedServiceInfo?.metadata?.editFieldsInfo;
  const editorDateField = editFieldsInfo?.editDateField || editFieldsInfo?.lastEditDateField;

  if (_isImageSvc) {
    signals.push({ signal: 'editor_tracking', value: null, confidence: 'none', detail: 'Skipped — ImageServer has no query endpoint' });
  } else if (editorDateField) {
    try {
      const maxDate = await queryMaxDate(queryTarget, editorDateField);
      if (maxDate) {
        signals.push({
          signal: 'editor_tracking',
          value: maxDate,
          confidence: 'high',
          detail: `MAX(${editorDateField}) = ${maxDate}`,
        });
      } else {
        signals.push({
          signal: 'editor_tracking',
          value: null,
          confidence: 'none',
          detail: `Editor tracking field "${editorDateField}" returned no data`,
        });
      }
    } catch (e) {
      signals.push({
        signal: 'editor_tracking',
        value: null,
        confidence: 'none',
        detail: `Failed to query editor tracking field: ${e.message}`,
      });
    }
  } else {
    signals.push({
      signal: 'editor_tracking',
      value: null,
      confidence: 'none',
      detail: 'Service does not have editor tracking enabled',
    });
  }

  // ── Signal 3: Common date field heuristics ──
  // Skip for ImageServer — no /query endpoint
  if (_isImageSvc) {
    signals.push({ signal: 'date_field_heuristic', value: null, confidence: 'none', detail: 'Skipped — ImageServer has no query endpoint' });
  } else {
  const dateFields = fields
    .filter(f => {
      const t = (f.type || '').toUpperCase();
      return t.includes('DATE');
    })
    .filter(f => {
      // Skip editor tracking field (already handled in Signal 2)
      if (editorDateField && f.name === editorDateField) return false;
      return true;
    })
    .sort((a, b) => dateFieldPriority(a.name) - dateFieldPriority(b.name));

  if (dateFields.length > 0) {
    // Query top 3 most promising date fields
    const topCandidates = dateFields.slice(0, 3);
    let bestDate = null;
    let bestField = null;

    for (const f of topCandidates) {
      try {
        const maxDate = await queryMaxDate(queryTarget, f.name);
        if (maxDate) {
          const d = new Date(maxDate);
          if (!isNaN(d.getTime())) {
            if (!bestDate || d > new Date(bestDate)) {
              bestDate = maxDate;
              bestField = f.name;
            }
          }
        }
      } catch (_) { /* skip */ }
    }

    if (bestDate) {
      const priority = dateFieldPriority(bestField);
      const conf = priority <= 1 ? 'medium' : 'low';
      signals.push({
        signal: 'date_field_heuristic',
        value: bestDate,
        confidence: conf,
        detail: `MAX(${bestField}) = ${bestDate}`,
      });
    } else {
      signals.push({
        signal: 'date_field_heuristic',
        value: null,
        confidence: 'none',
        detail: `Queried ${topCandidates.map(f => f.name).join(', ')} — no dates found`,
      });
    }
  } else {
    signals.push({
      signal: 'date_field_heuristic',
      value: null,
      confidence: 'none',
      detail: 'No date-type fields found in schema',
    });
  }
  } // end else (non-ImageServer) for Signal 3

  // ── Signal 4: Record count delta ──
  // Skip for ImageServer — no /query endpoint
  let currentCount = null;
  if (!_isImageSvc) {
  try {
    const countParams = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
    const countJson = await fetchJsonWithTimeout(`${queryTarget}/query?${countParams}`, 6000);
    currentCount = countJson?.count ?? null;
  } catch (_) { /* skip */ }
  }

  if (currentCount !== null && storedRecordCount !== null) {
    const delta = currentCount - storedRecordCount;
    if (delta !== 0) {
      signals.push({
        signal: 'record_count_delta',
        value: `${delta > 0 ? '+' : ''}${delta}`,
        confidence: 'low',
        detail: `Record count changed: ${storedRecordCount.toLocaleString()} → ${currentCount.toLocaleString()} (${delta > 0 ? '+' : ''}${delta.toLocaleString()})`,
      });
    } else {
      signals.push({
        signal: 'record_count_delta',
        value: '0',
        confidence: 'low',
        detail: `Record count unchanged: ${currentCount.toLocaleString()}`,
      });
    }
  } else {
    signals.push({
      signal: 'record_count_delta',
      value: null,
      confidence: 'none',
      detail: storedRecordCount === null
        ? 'No stored baseline record count'
        : 'Could not fetch current record count',
    });
  }

  // ── Signal 5: Metadata text parsing ──
  const descText = serviceJson?.serviceDescription || serviceJson?.description || '';
  const copyrightText = serviceJson?.copyrightText || '';
  const allText = `${descText} ${copyrightText}`;
  const dateMatch = allText.match(
    /(?:last\s+(?:updated?|modified|revised|edited))[:\s]*(\w+\s+\d{1,2},?\s+\d{4}|\d{4}[-\/]\d{2}[-\/]\d{2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i
  );
  if (dateMatch) {
    try {
      const parsed = new Date(dateMatch[1]);
      if (!isNaN(parsed.getTime())) {
        signals.push({
          signal: 'metadata_text',
          value: parsed.toISOString(),
          confidence: 'low',
          detail: `Found "${dateMatch[0]}" in service description/copyright text`,
        });
      }
    } catch (_) { /* skip */ }
  }
  if (!dateMatch || !signals.find(s => s.signal === 'metadata_text')) {
    signals.push({
      signal: 'metadata_text',
      value: null,
      confidence: 'none',
      detail: 'No "last updated" date found in service metadata text',
    });
  }

  // ── Pick the best signal ──
  const confOrder = { high: 0, medium: 1, low: 2, none: 3 };
  const ranked = signals
    .filter(s => s.value !== null)
    .sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);

  if (ranked.length > 0) {
    const best = ranked[0];
    return {
      lastUpdated: best.value,
      signal: best.signal,
      confidence: best.confidence,
      details: best.detail,
      signals,
      recordCount: currentCount,
    };
  }

  return {
    lastUpdated: null,
    signal: 'none',
    confidence: 'none',
    details: 'Could not determine freshness from any signal',
    signals,
    recordCount: currentCount,
  };
}

// ── Date validation (rejects unrealistic dates like year 9999) ──

function isValidRealisticDate(date) {
  if (!date || isNaN(date.getTime())) return false;
  const year = date.getFullYear();
  const now = new Date();
  const currentYear = now.getFullYear();
  // Reject dates before widespread GIS adoption (1990) or more than 1 year in the future
  if (year < 1990 || year > currentYear + 1) return false;
  // Reject dates that are exactly on sentinel values often used as placeholders
  if (year === 9999 || year === 1899 || year === 1900 || year === 1970 && date.getMonth() === 0 && date.getDate() === 1) return false;
  return true;
}

// ── Query MAX(dateField) ──

async function queryMaxDate(queryTarget, fieldName) {
  const params = new URLSearchParams({
    where: '1=1',
    outStatistics: JSON.stringify([
      { statisticType: 'max', onStatisticField: fieldName, outStatisticFieldName: 'max_date' }
    ]),
    f: 'json',
  });
  const json = await fetchJsonWithTimeout(`${queryTarget}/query?${params}`, 8000);
  const val = json?.features?.[0]?.attributes?.max_date;
  if (val === null || val === undefined) return null;

  // ArcGIS returns dates as Unix timestamps (milliseconds)
  if (typeof val === 'number') {
    const d = new Date(val);
    return isValidRealisticDate(d) ? d.toISOString() : null;
  }
  // Or sometimes as ISO strings
  if (typeof val === 'string') {
    const d = new Date(val);
    return isValidRealisticDate(d) ? d.toISOString() : null;
  }
  return null;
}

// ── Display helpers ──

const CONFIDENCE_META = {
  high:   { label: 'High confidence',   icon: '\u25CF', color: 'var(--green)', css: 'freshness-high' },
  medium: { label: 'Medium confidence',  icon: '\u25CF', color: 'var(--amber)', css: 'freshness-medium' },
  low:    { label: 'Low confidence',     icon: '\u25CF', color: 'var(--red)',   css: 'freshness-low' },
  none:   { label: 'Unknown',            icon: '\u25CB', color: 'var(--text-muted)', css: 'freshness-none' },
};

export function getConfidenceMeta(confidence) {
  return CONFIDENCE_META[confidence] || CONFIDENCE_META.none;
}

const SIGNAL_LABELS = {
  'editingInfo.lastEditDate': 'ArcGIS Server edit timestamp',
  'editor_tracking':          'Editor tracking field query',
  'date_field_heuristic':     'Date field heuristic (MAX query)',
  'record_count_delta':       'Record count change',
  'metadata_text':            'Service description text',
  'none':                     'No signal available',
};

export function getSignalLabel(signal) {
  return SIGNAL_LABELS[signal] || signal;
}

export function formatFreshnessAge(isoDate) {
  if (!isoDate) return 'Unknown';
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return 'Unknown';
  const now = new Date();
  const diffMs = now - d;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days < 1) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? 's' : ''} ago`;
  }
  const years = Math.floor(days / 365);
  const remainingMonths = Math.floor((days % 365) / 30);
  return remainingMonths > 0
    ? `${years}y ${remainingMonths}m ago`
    : `${years} year${years > 1 ? 's' : ''} ago`;
}

export function freshnessColor(isoDate) {
  if (!isoDate) return 'var(--text-muted)';
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return 'var(--text-muted)';
  const days = Math.floor((new Date() - d) / (1000 * 60 * 60 * 24));
  if (days <= 90) return 'var(--green)';
  if (days <= 365) return 'var(--amber)';
  return 'var(--red)';
}
