import { escapeHtml } from './utils.js';

// ====== ARCGIS REST PREVIEW HELPERS (static image + metadata + sample) ======

export function normalizeServiceUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  return u.replace(/\/+$/, '');
}

/**
 * Parse an ArcGIS REST URL into its service base and (optional) layer id.
 *   • .../FeatureServer/3  → { serviceUrl: '.../FeatureServer', layerId: 3, isLayerUrl: true }
 *   • .../MapServer         → { serviceUrl: '.../MapServer',    layerId: null, isLayerUrl: false }
 */
export function parseServiceAndLayerId(rawUrl) {
  const url = normalizeServiceUrl(rawUrl);
  // Match trailing /MapServer/0, /FeatureServer/12, /ImageServer/3 etc.
  const m = url.match(/^(.*\/(?:MapServer|FeatureServer|ImageServer))\/([0-9]+)$/i);
  if (m) {
    return { serviceUrl: m[1], layerId: Number(m[2]), isLayerUrl: true };
  }
  return { serviceUrl: url, layerId: null, isLayerUrl: false };
}

export function looksLikeArcGisService(url) {
  const u = String(url || '').toUpperCase();
  // ArcGIS Server can be deployed at any context path (not just /arcgis/)
  // Common patterns: /arcgis/rest/services/, /nlsdb/rest/services/, /gis/rest/services/
  // The reliable marker is /rest/services/ combined with a service type endpoint
  return u.includes('/REST/SERVICES/') && (u.includes('/MAPSERVER') || u.includes('/FEATURESERVER') || u.includes('/IMAGESERVER'));
}

export async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store', signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchServiceJson(serviceUrl) {
  const base = normalizeServiceUrl(serviceUrl);
  const u = base.includes('?') ? `${base}&f=pjson` : `${base}?f=pjson`;
  return fetchJsonWithTimeout(u);
}

export async function fetchLayerJson(serviceUrl, layerId = 0) {
  const base = normalizeServiceUrl(serviceUrl);
  // If the URL already points to a layer endpoint, use it directly
  const parsed = parseServiceAndLayerId(base);
  const target = parsed.isLayerUrl ? base : `${base}/${layerId}`;
  const u = `${target}?f=pjson`;
  return fetchJsonWithTimeout(u);
}

export async function fetchSampleRows(serviceUrl, layerId = 0, n = 8) {
  const base = normalizeServiceUrl(serviceUrl);
  const parsed = parseServiceAndLayerId(base);
  const target = parsed.isLayerUrl ? base : `${base}/${layerId}`;
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'false',
    resultRecordCount: String(n),
    f: 'json',
  });
  const u = `${target}/query?${params.toString()}`;
  return fetchJsonWithTimeout(u);
}

/**
 * Fetch N truly random rows by picking unique random offsets into the
 * ordered result set and querying each individually.
 * Returns an array of attribute objects (may be shorter than n if some fail).
 */
export async function fetchRandomSampleRows(serviceUrl, layerId = 0, oidField = 'OBJECTID', totalCount = 0, n = 5) {
  const base = normalizeServiceUrl(serviceUrl);
  const parsed = parseServiceAndLayerId(base);
  const target = parsed.isLayerUrl ? base : `${base}/${layerId}`;

  // If we don't know the total count, try to fetch it
  if (!totalCount || totalCount < 1) {
    try {
      const cp = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
      const cj = await fetchJsonWithTimeout(`${target}/query?${cp}`, 5000);
      if (cj && typeof cj.count === 'number') totalCount = cj.count;
    } catch {}
  }
  if (!totalCount || totalCount < 1) return [];

  // Generate n unique random offsets
  const sampleSize = Math.min(n, totalCount);
  const offsets = new Set();
  let safetyCount = sampleSize * 20;
  while (offsets.size < sampleSize && safetyCount-- > 0) {
    offsets.add(Math.floor(Math.random() * totalCount));
  }

  // Fetch each random row individually using resultOffset + orderByFields
  const rows = await Promise.all([...offsets].map(async (offset) => {
    try {
      const params = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        returnGeometry: 'false',
        resultRecordCount: '1',
        resultOffset: String(offset),
        orderByFields: oidField,
        f: 'json',
      });
      const json = await fetchJsonWithTimeout(`${target}/query?${params}`, 5000);
      if (json?.features?.[0]?.attributes) return json.features[0].attributes;
    } catch {}
    return null;
  }));

  return rows.filter(Boolean);
}

// Initialize interactive ArcGIS map for dataset preview
export let currentMapView = null;

// Render generation counter — incremented each time renderDatasetDetail is called.
// Async operations (preview, coverage map) check this to avoid painting into stale DOM.
export let _renderGeneration = 0;

export function getRenderGeneration() { return _renderGeneration; }
export function incrementRenderGeneration() { return ++_renderGeneration; }
export function getCurrentMapView() { return currentMapView; }
export function setCurrentMapView(v) { currentMapView = v; }

export function initializeArcGISMap(serviceUrl, layerId) {
  const mapContainer = document.getElementById('arcgisMapContainer');
  if (!mapContainer) return;

  // Destroy previous map view if exists
  if (currentMapView) {
    currentMapView.destroy();
    currentMapView = null;
  }

  // Check if ArcGIS API is loaded
  if (typeof require === 'undefined') {
    mapContainer.innerHTML = '<p style="padding:1rem; color:var(--text-muted);">ArcGIS API not available</p>';
    return;
  }

  mapContainer.innerHTML = '<p style="padding:1rem; color:var(--text-muted);">Loading map...</p>';

  require([
    "esri/Map",
    "esri/views/MapView",
    "esri/layers/MapImageLayer",
    "esri/layers/FeatureLayer"
  ], function(Map, MapView, MapImageLayer, FeatureLayer) {
    try {
      const upper = serviceUrl.toUpperCase();
      let layer;

      if (upper.includes('/MAPSERVER')) {
        // Use MapImageLayer for MapServer
        layer = new MapImageLayer({
          url: serviceUrl
        });
      } else if (upper.includes('/FEATURESERVER')) {
        // Use FeatureLayer for FeatureServer
        const layerUrl = serviceUrl.replace(/\/FeatureServer\/?$/i, `/FeatureServer/${layerId}`);
        layer = new FeatureLayer({
          url: layerUrl
        });
      } else {
        mapContainer.innerHTML = '<p style="padding:1rem; color:var(--text-muted);">Unsupported service type for interactive map</p>';
        return;
      }

      const map = new Map({
        basemap: "dark-gray-vector",
        layers: [layer]
      });

      mapContainer.innerHTML = ''; // Clear loading text
      
      currentMapView = new MapView({
        container: mapContainer,
        map: map,
        zoom: 4,
        center: [-98.5795, 39.8283] // Center of US
      });

      // Zoom to layer extent when loaded (wait for view.ready to avoid animation errors)
      layer.when(function() {
        if (layer.fullExtent && currentMapView) {
          currentMapView.when(function() {
            currentMapView.goTo(layer.fullExtent, { animate: false }).catch(function(err) {
              console.warn('Could not zoom to layer extent:', err);
            });
          });
        }
      }).catch(function(err) {
        console.warn('Layer failed to load:', err);
        mapContainer.innerHTML = '<p style="padding:1rem; color:var(--text-muted);">Could not load layer in map</p>';
      });

    } catch (err) {
      console.error('Error initializing ArcGIS map:', err);
      mapContainer.innerHTML = '<p style="padding:1rem; color:var(--text-muted);">Error loading map</p>';
    }
  });
}

// ── Cached service info loader ──

async function fetchCachedServiceInfo(datasetId) {
  if (!datasetId) return null;
  try {
    const resp = await fetch(`data/service-info/${encodeURIComponent(datasetId)}.json`, { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ── Extract metadata properties from live-fetched service/layer JSON ──

function extractMetadataProps(serviceJson, layerJson, recordCount) {
  const documentInfo = serviceJson.documentInfo || {};
  const spatialRef = serviceJson.spatialReference || layerJson?.spatialReference || {};
  const extent = layerJson?.extent || serviceJson.fullExtent || null;
  return {
    serviceDescription: serviceJson.serviceDescription || serviceJson.description || '',
    copyrightText: serviceJson.copyrightText || '',
    author: documentInfo.Author || '',
    subject: documentInfo.Subject || '',
    keywords: documentInfo.Keywords || '',
    comments: documentInfo.Comments || '',
    currentVersion: serviceJson.currentVersion || '',
    maxRecordCount: serviceJson.maxRecordCount || '',
    wkid: spatialRef.latestWkid || spatialRef.wkid || '',
    capabilities: serviceJson.capabilities || '',
    syncEnabled: serviceJson.syncEnabled ?? null,
    supportedQueryFormats: layerJson?.supportedQueryFormats || serviceJson.supportedQueryFormats || '',
    layerName: layerJson?.name || '',
    layerType: layerJson?.type || '',
    geometryType: layerJson?.geometryType || '',
    objectIdField: layerJson?.objectIdField || '',
    globalIdField: layerJson?.globalIdField || '',
    displayField: layerJson?.displayField || '',
    supportsStatistics: layerJson?.supportsStatistics ?? serviceJson.supportsStatistics ?? null,
    supportsAdvancedQueries: layerJson?.advancedQueryCapabilities?.supportsAdvancedQueries ?? null,
    hasAttachments: layerJson?.hasAttachments ?? null,
    hasZ: layerJson?.hasZ ?? null,
    hasM: layerJson?.hasM ?? null,
    minScale: layerJson?.minScale || 0,
    maxScale: layerJson?.maxScale || 0,
    editFieldsInfo: !!(layerJson?.editFieldsInfo),
    featureCount: layerJson?.featureCount ?? null,
    lastEditDate: layerJson?.editingInfo?.lastEditDate || serviceJson.editingInfo?.lastEditDate || null,
    definitionExpression: layerJson?.definitionExpression || '',
    recordCount,
    extent: extent ? { xmin: extent.xmin, ymin: extent.ymin, xmax: extent.xmax, ymax: extent.ymax } : null,
  };
}

// ── Friendly ESRI field type labels ──

const ESRI_TYPE_LABELS = {
  'ESRIFIELDTYPEOID':         'OID',
  'ESRIFIELDTYPEGLOBALID':    'GlobalID',
  'ESRIFIELDTYPESTRING':      'String',
  'ESRIFIELDTYPEINTEGER':     'Integer',
  'ESRIFIELDTYPESMALLINTEGER': 'SmallInt',
  'ESRIFIELDTYPEDOUBLE':      'Double',
  'ESRIFIELDTYPESINGLE':      'Single',
  'ESRIFIELDTYPEDATE':        'Date',
  'ESRIFIELDTYPEBLOB':        'Blob',
  'ESRIFIELDTYPEGUID':        'GUID',
  'ESRIFIELDTYPEXML':         'XML',
  'ESRIFIELDTYPEGEOMETRY':    'Geometry',
  'ESRIFIELDTYPERASTER':      'Raster',
};

function friendlyType(esriType) {
  const key = String(esriType || '').toUpperCase().replace(/\s/g, '');
  return ESRI_TYPE_LABELS[key] || esriType || '';
}

// ── Build Service Metadata card HTML ──

function buildMetadataCardHTML(m, { isCached = false, generatedDate = '' } = {}) {
  const badge = isCached ? 'Cached' : 'Auto';
  const subtitle = isCached
    ? `Generated ${generatedDate} from ArcGIS REST endpoint`
    : 'Fetched from the ArcGIS REST endpoint';
  const refreshBtn = isCached
    ? '<button type="button" class="btn" data-refresh-metadata title="Refresh from live service" style="padding:0.25rem 0.6rem;font-size:0.78rem;">&#x21bb; Refresh</button>'
    : '';

  return `
    <div class="card" style="margin-top:0.75rem;" id="serviceMetadataCard">
      <div class="card-header-row">
        <div style="font-weight:600;">Service Metadata</div>
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span class="data-source-badge data-source-badge-${isCached ? 'cached' : 'auto'}">${badge}</span>
          ${refreshBtn}
        </div>
      </div>
      <p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">${subtitle}</p>
      
      ${m.serviceDescription
        ? `<div class="collapsible-text-container">
             <p><strong>Description:</strong></p>
             <div class="collapsible-text ${m.serviceDescription.length > 300 ? 'is-collapsed' : ''}" data-full-text="${escapeHtml(m.serviceDescription)}">
               ${escapeHtml(m.serviceDescription)}
             </div>
             ${m.serviceDescription.length > 300 ? '<button type="button" class="show-more-btn" data-toggle-collapse>Show more</button>' : ''}
           </div>`
        : '<p class="metadata-missing"><strong>Description:</strong> <em>Not provided by service</em></p>'
      }
      
      ${m.copyrightText
        ? `<p><strong>Copyright:</strong> ${escapeHtml(m.copyrightText)}</p>`
        : '<p class="metadata-missing"><strong>Copyright:</strong> <em>Not provided by service</em></p>'
      }
      ${m.author
        ? `<p><strong>Author:</strong> ${escapeHtml(m.author)}</p>`
        : '<p class="metadata-missing"><strong>Author:</strong> <em>Not provided by service</em></p>'
      }
      ${m.subject ? `<p><strong>Subject:</strong> ${escapeHtml(m.subject)}</p>` : ''}
      ${m.keywords
        ? `<p><strong>Keywords:</strong> ${escapeHtml(m.keywords).split(',').map(k => `<span class="capability-pill">${k.trim()}</span>`).join(' ')}</p>`
        : ''
      }
      ${m.comments
        ? `<div class="collapsible-text-container">
             <p><strong>Comments:</strong></p>
             <div class="collapsible-text ${m.comments.length > 300 ? 'is-collapsed' : ''}" data-full-text="${escapeHtml(m.comments)}">
               ${escapeHtml(m.comments)}
             </div>
             ${m.comments.length > 300 ? '<button type="button" class="show-more-btn" data-toggle-collapse>Show more</button>' : ''}
           </div>`
        : ''
      }
      
      <div class="metadata-grid">
        ${m.layerName ? `<div class="metadata-item"><span class="metadata-label">Layer Name</span><span class="metadata-value">${escapeHtml(m.layerName)}</span></div>` : ''}
        ${m.layerType ? `<div class="metadata-item"><span class="metadata-label">Layer Type</span><span class="metadata-value">${escapeHtml(m.layerType)}</span></div>` : ''}
        ${m.currentVersion ? `<div class="metadata-item"><span class="metadata-label">Server Version</span><span class="metadata-value">${escapeHtml(String(m.currentVersion))}</span></div>` : ''}
        ${m.wkid ? `<div class="metadata-item"><span class="metadata-label">Spatial Reference</span><span class="metadata-value">EPSG:${escapeHtml(String(m.wkid))}</span></div>` : ''}
        ${m.geometryType ? `<div class="metadata-item"><span class="metadata-label">Geometry Type</span><span class="metadata-value">${escapeHtml(m.geometryType.replace('esriGeometry', ''))}</span></div>` : ''}
        ${m.maxRecordCount ? `<div class="metadata-item"><span class="metadata-label">Max Record Count</span><span class="metadata-value">${Number(m.maxRecordCount).toLocaleString()}</span></div>` : ''}
        ${m.featureCount !== null && m.featureCount !== undefined ? `<div class="metadata-item"><span class="metadata-label">Feature Count</span><span class="metadata-value">${Number(m.featureCount).toLocaleString()}</span></div>` : ''}
        ${m.objectIdField ? `<div class="metadata-item"><span class="metadata-label">Object ID Field</span><span class="metadata-value"><code>${escapeHtml(m.objectIdField)}</code></span></div>` : ''}
        ${m.globalIdField ? `<div class="metadata-item"><span class="metadata-label">Global ID Field</span><span class="metadata-value"><code>${escapeHtml(m.globalIdField)}</code></span></div>` : ''}
        ${m.displayField ? `<div class="metadata-item"><span class="metadata-label">Display Field</span><span class="metadata-value"><code>${escapeHtml(m.displayField)}</code></span></div>` : ''}
        ${m.recordCount !== null && m.recordCount !== undefined ? `<div class="metadata-item"><span class="metadata-label">Total Records</span><span class="metadata-value">${Number(m.recordCount).toLocaleString()}</span></div>` : ''}
        ${m.lastEditDate ? `<div class="metadata-item"><span class="metadata-label">Last Edited</span><span class="metadata-value">${new Date(m.lastEditDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span></div>` : ''}
        ${m.supportedQueryFormats ? `<div class="metadata-item"><span class="metadata-label">Query Formats</span><span class="metadata-value">${escapeHtml(m.supportedQueryFormats)}</span></div>` : ''}
      </div>
      
      <div class="metadata-capabilities">
        ${m.capabilities
          ? `<p><strong>Capabilities:</strong> ${m.capabilities.split(',').map(c => `<span class="capability-pill">${escapeHtml(c.trim())}</span>`).join(' ')}</p>`
          : ''
        }
        <div class="capability-flags">
          ${m.supportsStatistics !== null && m.supportsStatistics !== undefined ? `<span class="capability-flag ${m.supportsStatistics ? 'is-supported' : 'is-not-supported'}">${m.supportsStatistics ? '✓' : '✗'} Statistics</span>` : ''}
          ${m.supportsAdvancedQueries !== null && m.supportsAdvancedQueries !== undefined ? `<span class="capability-flag ${m.supportsAdvancedQueries ? 'is-supported' : 'is-not-supported'}">${m.supportsAdvancedQueries ? '✓' : '✗'} Advanced Queries</span>` : ''}
          ${m.hasAttachments !== null && m.hasAttachments !== undefined ? `<span class="capability-flag ${m.hasAttachments ? 'is-supported' : 'is-not-supported'}">${m.hasAttachments ? '✓' : '✗'} Attachments</span>` : ''}
          ${m.hasZ !== null && m.hasZ !== undefined ? `<span class="capability-flag ${m.hasZ ? 'is-supported' : 'is-not-supported'}">${m.hasZ ? '✓' : '✗'} Z Values</span>` : ''}
          ${m.hasM !== null && m.hasM !== undefined ? `<span class="capability-flag ${m.hasM ? 'is-supported' : 'is-not-supported'}">${m.hasM ? '✓' : '✗'} M Values</span>` : ''}
          ${m.editFieldsInfo ? '<span class="capability-flag is-supported">✓ Editor Tracking</span>' : ''}
          ${m.syncEnabled !== null && m.syncEnabled !== undefined ? `<span class="capability-flag ${m.syncEnabled ? 'is-supported' : 'is-not-supported'}">${m.syncEnabled ? '✓' : '✗'} Sync</span>` : ''}
        </div>
      </div>
      
      ${m.definitionExpression ? `<p style="margin-top:0.5rem;"><strong>Definition Expression:</strong> <code style="word-break:break-all;">${escapeHtml(m.definitionExpression)}</code></p>` : ''}
      
      ${(m.minScale > 0 || m.maxScale > 0)
        ? `<p><strong>Visibility Scale Range:</strong> ${m.maxScale > 0 ? '1:' + Number(m.maxScale).toLocaleString() : 'Any'} – ${m.minScale > 0 ? '1:' + Number(m.minScale).toLocaleString() : 'Any'}</p>`
        : ''
      }
      
      ${m.extent && m.extent.xmin !== undefined
        ? `<details class="extent-details">
             <summary><strong>Full Extent</strong></summary>
             <div class="extent-coords">
               <span>xmin: ${m.extent.xmin?.toFixed(4)}</span>
               <span>ymin: ${m.extent.ymin?.toFixed(4)}</span>
               <span>xmax: ${m.extent.xmax?.toFixed(4)}</span>
               <span>ymax: ${m.extent.ymax?.toFixed(4)}</span>
             </div>
           </details>`
        : ''
      }
    </div>
  `;
}

// ── Build Interactive Map card HTML ──

function buildMapCardHTML(url, layerId) {
  return `
    <div class="card" style="margin-top:0.75rem;">
      <div class="card-header-row"><div style="font-weight:600;">Interactive Map</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
      <div style="color:var(--text-muted); margin-bottom:0.5rem; font-size:0.9rem;">Pan and zoom to explore the dataset</div>
      <div id="arcgisMapContainer"
           data-service-url="${escapeHtml(url)}"
           data-layer-id="${layerId}"
           style="width:100%; height:400px; border-radius:12px; overflow:hidden; background:#e0e0e0;"></div>
    </div>
  `;
}

// ── Build Fields card HTML ──

function buildFieldsCardHTML(fields, fieldStats, { isCached = false, generatedDate = '', oidFieldName = '', globalIdFieldName = '' } = {}) {
  if (!fields || !fields.length) return '';

  const badge = isCached ? 'Cached' : 'Auto';
  const refreshBtn = isCached
    ? '<button type="button" class="btn" data-refresh-fields title="Refresh from live service" style="padding:0.25rem 0.6rem;font-size:0.78rem;">&#x21bb; Refresh</button>'
    : '';
  const subtitle = isCached
    ? `${fields.length} fields. Generated ${generatedDate}. Null % and Distinct counts pre-computed.`
    : `${fields.length} fields. Null % and Distinct counts are computed from the full dataset via service statistics queries.`;

  const oidUpper = oidFieldName.toUpperCase();
  const globalIdUpper = globalIdFieldName.toUpperCase();

  function isKeyField(f) {
    const n = (f.name || '').toUpperCase();
    const t = (f.type || '').toUpperCase();
    return n === oidUpper || n === globalIdUpper
      || t === 'ESRIFIELDTYPEOID' || t === 'ESRIFIELDTYPEGLOBALID';
  }

  // Build a lookup map for pre-computed stats
  const statsMap = {};
  if (fieldStats && fieldStats.length) {
    fieldStats.forEach(s => { statsMap[s.name] = s; });
  }

  const hasPrecomputedStats = isCached && fieldStats && fieldStats.length > 0;

  return `
    <div class="card card-fields" style="margin-top:0.75rem;" id="fieldsCard">
      <div class="card-header-row">
        <div style="font-weight:600;">Fields</div>
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span class="data-source-badge data-source-badge-${isCached ? 'cached' : 'auto'}">${badge}</span>
          ${refreshBtn}
        </div>
      </div>
      <p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">${subtitle}</p>
      <div style="overflow-x:auto;">
        <table class="fields-table" id="fieldsTable">
          <thead>
            <tr>
              <th>Field Name</th>
              <th>Alias</th>
              <th>Type</th>
              <th class="fields-stat-col">Null %</th>
              <th class="fields-stat-col">Distinct</th>
            </tr>
          </thead>
          <tbody>
            ${fields.map((f, i) => {
              const key = isKeyField(f);
              const hasDomain = !!(f.domain && (f.domain.type === 'codedValue' || f.domain === true));
              const rowCls = key ? ' class="field-row-key"' : (hasDomain ? ' class="field-row-domain"' : '');
              const fieldBadge = key ? '<span class="field-key-badge">KEY</span>' : (hasDomain ? '<span class="field-domain-badge">DOMAIN</span>' : '');

              // Pre-computed stats (cached) or loading placeholders (live)
              let nullCell, uniqCell;
              const stat = statsMap[f.name];
              if (hasPrecomputedStats && stat && !stat.skipped) {
                const nullPct = stat.nullPct;
                nullCell = nullPct !== null && nullPct !== undefined
                  ? (nullPct > 0
                    ? `<span class="field-stat-bar" style="--pct:${Math.min(nullPct, 100).toFixed(0)}%">${Number(nullPct).toFixed(1)}%</span>`
                    : '<span class="field-stat-zero">0%</span>')
                  : '\u2014';
                const dc = stat.distinctCount;
                if (dc !== null && dc !== undefined) {
                  if (stat.hasDomain) {
                    const dvCount = f.domain?.codedValueCount || dc;
                    uniqCell = `<span class="field-stat-domain">${dc.toLocaleString()} of ${dvCount} codes</span>`;
                  } else if (dc <= 25) {
                    uniqCell = `<span class="field-stat-low-card">${dc.toLocaleString()}</span>`;
                  } else {
                    uniqCell = `<span class="field-stat-count">${dc.toLocaleString()}</span>`;
                  }
                } else {
                  uniqCell = '\u2014';
                }
              } else if (hasPrecomputedStats && stat && stat.skipped) {
                nullCell = '\u2014';
                uniqCell = '\u2014';
              } else {
                nullCell = `<span class="field-stat-loading">\u2022\u2022\u2022</span>`;
                uniqCell = `<span class="field-stat-loading">\u2022\u2022\u2022</span>`;
              }

              return `<tr${rowCls} data-field-idx="${i}">
                <td class="field-name-cell">${fieldBadge}<code>${escapeHtml(f.name)}</code></td>
                <td>${escapeHtml(f.alias || '')}</td>
                <td><span class="field-type-pill">${escapeHtml(friendlyType(f.type))}</span></td>
                <td class="fields-stat-col" data-field-null="${i}">${nullCell}</td>
                <td class="fields-stat-col" data-field-uniq="${i}">${uniqCell}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ── Build Sample Records card HTML ──

function buildSampleCardHTML(rows, recordCount, { isCached = false, generatedDate = '' } = {}) {
  const badge = isCached ? 'Cached' : 'Auto';
  const refreshBtn = '<button type="button" class="btn" data-sample-refresh title="Fetch new random sample from live service" style="padding:0.25rem 0.6rem;font-size:0.78rem;">&#x21bb; Refresh</button>';

  let bodyHTML;
  if (rows && rows.length) {
    const cols = Object.keys(rows[0]);
    bodyHTML = `
      <div style="overflow:auto;">
        <table>
          <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else {
    bodyHTML = '<p class="loading-message" style="font-size:0.85rem;">Selecting random rows\u2026</p>';
  }

  const total = recordCount != null ? `${Number(recordCount).toLocaleString()} total records in service. ` : '';
  const desc = rows && rows.length
    ? `${total}Showing ${rows.length} ${isCached ? 'cached sample' : 'randomly selected'} rows.${isCached ? ' Generated ' + generatedDate + '.' : ''}`
    : `${total}Loading random sample\u2026`;

  return `
    <div class="card" id="sampleRecordsCard" style="margin-top:0.75rem;">
      <div class="card-header-row">
        <div style="font-weight:600;">Sample Records</div>
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span class="data-source-badge data-source-badge-${isCached ? 'cached' : 'auto'}">${badge}</span>
          ${refreshBtn}
        </div>
      </div>
      <p class="text-muted" data-sample-desc style="margin-bottom:0.5rem;font-size:0.85rem;">${desc}</p>
      <div data-sample-content>${bodyHTML}</div>
    </div>
  `;
}

// ── Async field stats loader (runs after live fields card renders) ──

function startAsyncFieldStats(contentEl, containingEl, fetchBaseUrl, layerId, allFields, generation) {
  const _fieldStatsUrl = fetchBaseUrl;
  const _fieldStatsLayerId = layerId;
  const _fieldStatsFields = allFields;
  const _fieldStatsGen = generation;

  setTimeout(async () => {
    if (_fieldStatsGen !== _renderGeneration) return;
    const table = contentEl.querySelector('#fieldsTable');
    if (!table) return;

    const _fieldStatsCollector = [];

    let totalCount = 0;
    try {
      const countParams = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
      const base = normalizeServiceUrl(_fieldStatsUrl);
      const parsed = parseServiceAndLayerId(base);
      const target = parsed.isLayerUrl ? base : `${base}/${_fieldStatsLayerId}`;
      const countJson = await fetchJsonWithTimeout(`${target}/query?${countParams}`, 8000);
      totalCount = (countJson && typeof countJson.count === 'number') ? countJson.count : 0;
    } catch {}
    if (_fieldStatsGen !== _renderGeneration || !totalCount) {
      table.querySelectorAll('[data-field-null], [data-field-uniq]').forEach(td => {
        td.textContent = '\u2014';
      });
      return;
    }

    const STAT_CONCURRENCY = 3;
    let fIdx = 0;

    async function processField() {
      while (fIdx < _fieldStatsFields.length) {
        const i = fIdx++;
        const f = _fieldStatsFields[i];
        if (_fieldStatsGen !== _renderGeneration) return;

        const nullCell = table.querySelector(`[data-field-null="${i}"]`);
        const uniqCell = table.querySelector(`[data-field-uniq="${i}"]`);
        if (!nullCell || !uniqCell) continue;

        const ft = (f.type || '').toUpperCase();
        if (ft.includes('GEOMETRY') || ft.includes('BLOB') || ft.includes('RASTER') || ft.includes('XML')) {
          nullCell.textContent = '\u2014';
          uniqCell.textContent = '\u2014';
          continue;
        }

        try {
          const base = normalizeServiceUrl(_fieldStatsUrl);
          const parsed = parseServiceAndLayerId(base);
          const target = parsed.isLayerUrl ? base : `${base}/${_fieldStatsLayerId}`;
          const statParams = new URLSearchParams({
            where: '1=1',
            outStatistics: JSON.stringify([
              { statisticType: 'count', onStatisticField: f.name, outStatisticFieldName: 'nn_count' }
            ]),
            f: 'json',
          });
          const statJson = await fetchJsonWithTimeout(`${target}/query?${statParams}`, 6000);
          const nnCount = (statJson?.features?.[0]?.attributes?.nn_count) ?? totalCount;
          const nullPct = totalCount > 0 ? ((totalCount - nnCount) / totalCount * 100) : 0;
          _fieldStatsCollector.push({ name: f.name, type: f.type, alias: f.alias || '', nullPct, hasDomain: !!(f.domain && f.domain.type === 'codedValue') });
          nullCell.innerHTML = nullPct > 0
            ? `<span class="field-stat-bar" style="--pct:${Math.min(nullPct, 100).toFixed(0)}%">${nullPct.toFixed(1)}%</span>`
            : '<span class="field-stat-zero">0%</span>';
        } catch {
          nullCell.textContent = '\u2014';
        }

        try {
          const base = normalizeServiceUrl(_fieldStatsUrl);
          const parsed = parseServiceAndLayerId(base);
          const target = parsed.isLayerUrl ? base : `${base}/${_fieldStatsLayerId}`;
          
          let distinctCount = null;
          try {
            const distParams1 = new URLSearchParams({
              where: '1=1', outFields: f.name, returnDistinctValues: 'true', returnCountOnly: 'true', f: 'json',
            });
            const distJson1 = await fetchJsonWithTimeout(`${target}/query?${distParams1}`, 5000);
            if (distJson1 && typeof distJson1.count === 'number') distinctCount = distJson1.count;
          } catch {}
          
          if (distinctCount === null) {
            try {
              const distParams2 = new URLSearchParams({
                where: '1=1', groupByFieldsForStatistics: f.name,
                outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: f.name, outStatisticFieldName: 'cnt' }]),
                f: 'json',
              });
              const distJson2 = await fetchJsonWithTimeout(`${target}/query?${distParams2}`, 5000);
              if (distJson2 && Array.isArray(distJson2.features)) distinctCount = distJson2.features.length;
            } catch {}
          }
          
          if (distinctCount != null && totalCount > 0) {
            const isUnique = distinctCount === totalCount;
            const hasDomain = f.domain && f.domain.type === 'codedValue';
            if (isUnique) {
              uniqCell.innerHTML = `<span class="field-stat-unique">${distinctCount.toLocaleString()}</span>`;
            } else if (hasDomain) {
              const domainCount = f.domain.codedValues ? f.domain.codedValues.length : distinctCount;
              uniqCell.innerHTML = `<span class="field-stat-domain">${distinctCount.toLocaleString()} of ${domainCount} codes</span>`;
            } else if (distinctCount <= 25) {
              uniqCell.innerHTML = `<span class="field-stat-low-card">${distinctCount.toLocaleString()}</span>`;
            } else {
              uniqCell.innerHTML = `<span class="field-stat-count">${distinctCount.toLocaleString()}</span>`;
            }
          } else {
            uniqCell.textContent = '\u2014';
          }
        } catch {
          uniqCell.textContent = '\u2014';
        }
      }
    }

    await Promise.all(Array.from({ length: STAT_CONCURRENCY }, processField));

    try {
      containingEl.dispatchEvent(new CustomEvent('maturity:field-stats', {
        detail: { fieldStats: _fieldStatsCollector, totalCount },
      }));
    } catch (_) {}
  }, 50);
}

// ── Wire sample records refresh (random rows from live service) ──

function wireSampleRefresh(contentEl, fetchBaseUrl, layerId, objectIdField, recordCount, generation) {
  const sampleCard = contentEl.querySelector('#sampleRecordsCard');
  if (!sampleCard) return;

  const _sOidField = objectIdField || 'OBJECTID';
  const _sUrl = fetchBaseUrl;
  const _sLayerId = layerId;
  const _sCount = recordCount || 0;
  const _sGen = generation;
  const _sContent = sampleCard.querySelector('[data-sample-content]');
  const _sDesc = sampleCard.querySelector('[data-sample-desc]');

  async function loadRandomSample() {
    if (_sGen !== _renderGeneration) return;
    _sContent.innerHTML = '<p class="loading-message" style="font-size:0.85rem;">Selecting random rows\u2026</p>';

    const rows = await fetchRandomSampleRows(_sUrl, _sLayerId, _sOidField, _sCount, 5);
    if (_sGen !== _renderGeneration) return;

    if (!rows.length) {
      _sContent.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">Could not fetch sample records.</p>';
      return;
    }

    const cols = Object.keys(rows[0]);
    const total = _sCount ? `${_sCount.toLocaleString()} total records in service. ` : '';
    _sDesc.textContent = `${total}Showing ${rows.length} randomly selected rows.`;

    // Update badge to show live data
    const badgeEl = sampleCard.querySelector('.data-source-badge');
    if (badgeEl) {
      badgeEl.textContent = 'Auto';
      badgeEl.className = 'data-source-badge data-source-badge-auto';
    }

    _sContent.innerHTML = `
      <div style="overflow:auto;">
        <table>
          <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  const refreshBtn = sampleCard.querySelector('[data-sample-refresh]');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadRandomSample());
  }

  return loadRandomSample;
}

// ── Render from cached service info ──

function renderFromCachedData(contentEl, statusEl, cached, url, generation, containingEl) {
  const m = cached.metadata;
  const generatedDate = new Date(cached.generated).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const parsed = parseServiceAndLayerId(url);
  const serviceBaseUrl = parsed.serviceUrl;
  const layerId = parsed.isLayerUrl ? parsed.layerId : 0;
  const _isTable = !m.geometryType || m.geometryType.toUpperCase() === 'TABLE';

  let html = '';

  // 1. Service Metadata card (from cache)
  html += buildMetadataCardHTML(m, { isCached: true, generatedDate });

  // 2. Interactive Map (live — still needs the ArcGIS widget)
  if (!_isTable) {
    html += buildMapCardHTML(url, layerId);
  }

  // 3. Fields card (from cache with pre-computed stats)
  html += buildFieldsCardHTML(cached.fields, cached.fieldStats, {
    isCached: true,
    generatedDate,
    oidFieldName: m.objectIdField || '',
    globalIdFieldName: m.globalIdField || '',
  });

  // 4. Sample Records card (from cache)
  html += buildSampleCardHTML(cached.sampleRows, m.recordCount, { isCached: true, generatedDate });

  contentEl.innerHTML = html;
  statusEl.textContent = `Preview loaded from cache (${generatedDate}).`;

  // Dispatch maturity events from cached data so the maturity card can score
  try {
    // Reconstruct minimal serviceJson/layerJson for maturity scoring
    const syntheticServiceJson = {
      capabilities: m.capabilities || '',
      supportsStatistics: m.supportsStatistics,
      spatialReference: m.wkid ? { wkid: m.wkid } : {},
      serviceDescription: m.serviceDescription || '',
      description: m.serviceDescription || '',
      copyrightText: m.copyrightText || '',
      documentInfo: { Author: m.author || '' },
    };
    const syntheticLayerJson = {
      supportsStatistics: m.supportsStatistics,
      advancedQueryCapabilities: { supportsAdvancedQueries: m.supportsAdvancedQueries },
      spatialReference: m.wkid ? { wkid: m.wkid } : {},
      fields: cached.fields || [],
    };
    containingEl.dispatchEvent(new CustomEvent('maturity:service-data', {
      detail: { serviceJson: syntheticServiceJson, layerJson: syntheticLayerJson },
    }));
  } catch (_) {}

  // Dispatch cached field stats for maturity
  if (cached.fieldStats && cached.fieldStats.length) {
    try {
      containingEl.dispatchEvent(new CustomEvent('maturity:field-stats', {
        detail: { fieldStats: cached.fieldStats, totalCount: m.recordCount || 0 },
      }));
    } catch (_) {}
  }

  // Wire sample records refresh (fetch new random rows from live service)
  const fetchBaseUrl = parsed.isLayerUrl ? url : serviceBaseUrl;
  wireSampleRefresh(contentEl, fetchBaseUrl, layerId, m.objectIdField, m.recordCount, generation);

  // Wire metadata refresh button
  const metaRefreshBtn = contentEl.querySelector('[data-refresh-metadata]');
  if (metaRefreshBtn) {
    metaRefreshBtn.addEventListener('click', async () => {
      const card = contentEl.querySelector('#serviceMetadataCard');
      if (!card) return;
      card.innerHTML = '<p class="loading-message" style="padding:1rem;font-size:0.85rem;">Refreshing from live service\u2026</p>';
      try {
        let sj;
        try { sj = await fetchServiceJson(serviceBaseUrl); } catch { sj = await fetchServiceJson(url); }
        let lj = null;
        try { lj = await fetchLayerJson(fetchBaseUrl, layerId); } catch {}
        if ((!lj || !Array.isArray(lj.fields)) && parsed.isLayerUrl) {
          try { const d = await fetchServiceJson(url); if (d && Array.isArray(d.fields)) lj = d; } catch {}
        }
        let rc = null;
        try {
          const cp = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
          const ct = parsed.isLayerUrl ? fetchBaseUrl : `${fetchBaseUrl}/${layerId}`;
          const cj = await fetchJsonWithTimeout(`${ct}/query?${cp}`, 5000);
          if (cj && typeof cj.count === 'number') rc = cj.count;
        } catch {}
        const liveProps = extractMetadataProps(sj, lj, rc);
        card.outerHTML = buildMetadataCardHTML(liveProps);
      } catch (e) {
        card.innerHTML = '<p class="text-muted" style="padding:1rem;font-size:0.85rem;">Failed to refresh metadata from live service.</p>';
      }
    });
  }

  // Wire fields refresh button
  const fieldsRefreshBtn = contentEl.querySelector('[data-refresh-fields]');
  if (fieldsRefreshBtn) {
    fieldsRefreshBtn.addEventListener('click', async () => {
      const card = contentEl.querySelector('#fieldsCard');
      if (!card) return;
      card.innerHTML = '<p class="loading-message" style="padding:1rem;font-size:0.85rem;">Refreshing fields from live service\u2026</p>';
      try {
        let lj = null;
        try { lj = await fetchLayerJson(fetchBaseUrl, layerId); } catch {}
        if ((!lj || !Array.isArray(lj.fields)) && parsed.isLayerUrl) {
          try { const d = await fetchServiceJson(url); if (d && Array.isArray(d.fields)) lj = d; } catch {}
        }
        if (lj && Array.isArray(lj.fields) && lj.fields.length) {
          card.outerHTML = buildFieldsCardHTML(lj.fields, null, {
            isCached: false,
            oidFieldName: lj.objectIdField || '',
            globalIdFieldName: lj.globalIdField || '',
          });
          // Start async field stats for the refreshed fields
          startAsyncFieldStats(contentEl, containingEl, fetchBaseUrl, layerId, lj.fields, generation);
        } else {
          card.innerHTML = '<p class="text-muted" style="padding:1rem;font-size:0.85rem;">No fields returned from live service.</p>';
        }
      } catch {
        card.innerHTML = '<p class="text-muted" style="padding:1rem;font-size:0.85rem;">Failed to refresh fields from live service.</p>';
      }
    });
  }

  // Initialize interactive map
  if (!_isTable) {
    initializeArcGISMap(serviceBaseUrl, layerId);
  }
}

// ── Main preview renderer ──

export async function maybeRenderPublicServicePreviewCard(hostEl, publicUrl, generation, options = {}) {
  if (!hostEl) return;
  const { datasetId, skipCache } = options;

  const card = hostEl.querySelector('#datasetPreviewCard');
  const statusEl = hostEl.querySelector('[data-preview-status]');
  const contentEl = hostEl.querySelector('[data-preview-content]');
  if (!card || !statusEl || !contentEl) return;

  // containingEl is hostEl (the dataset detail panel) — used for dispatching maturity events
  const containingEl = hostEl;

  const url = normalizeServiceUrl(publicUrl);
  if (!url) {
    statusEl.textContent = 'No Public Web Service provided for this dataset.';
    return;
  }

  if (!looksLikeArcGisService(url)) {
    statusEl.textContent = 'Not recognized as an ArcGIS REST Map/Feature service.';
    contentEl.innerHTML = `
      <div class="card" style="margin-top:0.75rem;">
        <p><strong>Link:</strong> <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></p>
      </div>
    `;
    return;
  }

  // avoid duplicate loads for same dataset re-render (unless refreshing)
  if (!skipCache && contentEl.getAttribute('data-preview-rendered') === url) return;
  contentEl.setAttribute('data-preview-rendered', url);

  // ── Try cached data first (unless explicitly skipping) ──
  if (!skipCache && datasetId) {
    const cached = await fetchCachedServiceInfo(datasetId);
    if (cached && cached.metadata) {
      renderFromCachedData(contentEl, statusEl, cached, url, generation, containingEl);
      return;
    }
  }

  // ── Live fetch path ──
  statusEl.textContent = 'Loading service preview…';
  contentEl.innerHTML = '';

  try {
    const parsed = parseServiceAndLayerId(url);
    const serviceBaseUrl = parsed.serviceUrl;
    const isLayerUrl = parsed.isLayerUrl;

    let serviceJson;
    try {
      serviceJson = await fetchServiceJson(serviceBaseUrl);
    } catch {
      serviceJson = await fetchServiceJson(url);
    }

    let layerId;
    if (isLayerUrl) {
      layerId = parsed.layerId;
    } else {
      layerId = (serviceJson.layers && serviceJson.layers.length)
        ? (serviceJson.layers[0].id ?? 0)
        : 0;
    }

    const fetchBaseUrl = isLayerUrl ? url : serviceBaseUrl;

    let layerJson = null;
    try { layerJson = await fetchLayerJson(fetchBaseUrl, layerId); } catch {}
    if ((!layerJson || !Array.isArray(layerJson.fields)) && isLayerUrl) {
      try {
        const direct = await fetchServiceJson(url);
        if (direct && Array.isArray(direct.fields)) layerJson = direct;
      } catch {}
    }

    let recordCount = null;
    try {
      const countParams = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
      const countTarget = isLayerUrl ? fetchBaseUrl : `${fetchBaseUrl}/${layerId}`;
      const countJson = await fetchJsonWithTimeout(`${countTarget}/query?${countParams}`, 5000);
      if (countJson && typeof countJson.count === 'number') recordCount = countJson.count;
    } catch {}

    if (generation !== _renderGeneration) return;

    // Dispatch maturity event
    try {
      containingEl.dispatchEvent(new CustomEvent('maturity:service-data', {
        detail: { serviceJson, layerJson },
      }));
    } catch (_) {}

    // Build metadata props and render cards using shared helpers
    const metaProps = extractMetadataProps(serviceJson, layerJson, recordCount);

    let html = '';
    html += buildMetadataCardHTML(metaProps);

    const _isTable = !metaProps.geometryType || metaProps.geometryType.toUpperCase() === 'TABLE';
    if (!_isTable) {
      html += buildMapCardHTML(url, layerId);
    }

    // Fields card (live — stats computed async)
    const allFields = (layerJson && Array.isArray(layerJson.fields)) ? layerJson.fields : [];
    if (allFields.length) {
      html += buildFieldsCardHTML(allFields, null, {
        isCached: false,
        oidFieldName: layerJson?.objectIdField || '',
        globalIdFieldName: layerJson?.globalIdField || '',
      });
    }

    // Sample records card (live — async random rows)
    html += buildSampleCardHTML(null, recordCount);

    contentEl.innerHTML = html;
    statusEl.textContent = 'Preview loaded.';

    // Start async field stats
    if (allFields.length) {
      startAsyncFieldStats(contentEl, containingEl, fetchBaseUrl, layerId, allFields, generation);
    }

    // Wire sample records refresh and load initial sample
    const loadSample = wireSampleRefresh(contentEl, fetchBaseUrl, layerId, metaProps.objectIdField, recordCount, generation);
    if (loadSample) loadSample();

    // Initialize interactive map
    if (!_isTable) {
      initializeArcGISMap(serviceBaseUrl, layerId);
    }

  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Failed to load preview (service JSON blocked or unavailable).';
    contentEl.innerHTML = `
      <div class="card" style="margin-top:0.75rem;">
        <p>We could not fetch service details in-browser. You can still open the link:</p>
        <p><a href="${escapeHtml(publicUrl)}" target="_blank" rel="noopener">${escapeHtml(publicUrl)}</a></p>
      </div>
    `;
  }
}
