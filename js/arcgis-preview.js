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

export async function maybeRenderPublicServicePreviewCard(hostEl, publicUrl, generation) {
  if (!hostEl) return;

  const card = hostEl.querySelector('#datasetPreviewCard');
  const statusEl = hostEl.querySelector('[data-preview-status]');
  const contentEl = hostEl.querySelector('[data-preview-content]');
  if (!card || !statusEl || !contentEl) return;

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

  // avoid duplicate loads for same dataset re-render
  if (contentEl.getAttribute('data-preview-rendered') === url) return;
  contentEl.setAttribute('data-preview-rendered', url);

  statusEl.textContent = 'Loading service preview…';
  contentEl.innerHTML = '';

  try {
    // Determine if URL is a layer endpoint or a service root
    const parsed = parseServiceAndLayerId(url);
    const serviceBaseUrl = parsed.serviceUrl;
    const isLayerUrl = parsed.isLayerUrl;

    // Fetch service-level JSON (for metadata, layer list, extent)
    let serviceJson;
    try {
      serviceJson = await fetchServiceJson(serviceBaseUrl);
    } catch {
      serviceJson = await fetchServiceJson(url);
    }

    // Choose the layer ID for field/sample queries
    let layerId;
    if (isLayerUrl) {
      layerId = parsed.layerId;
    } else {
      layerId = (serviceJson.layers && serviceJson.layers.length)
        ? (serviceJson.layers[0].id ?? 0)
        : 0;
    }

    // For layer-level fetches use the right base URL
    const fetchBaseUrl = isLayerUrl ? url : serviceBaseUrl;

    const upper = url.toUpperCase();

    // Layer fields + sample rows (best-effort)
    let layerJson = null;
    let sampleJson = null;
    try { layerJson = await fetchLayerJson(fetchBaseUrl, layerId); } catch {}
    // If layerJson came back without fields (e.g. it was a service-root hit),
    // and the original URL already had fields, try the original URL directly.
    if ((!layerJson || !Array.isArray(layerJson.fields)) && isLayerUrl) {
      try {
        const direct = await fetchServiceJson(url); // layer-level JSON
        if (direct && Array.isArray(direct.fields)) layerJson = direct;
      } catch {}
    }
    try { sampleJson = await fetchSampleRows(fetchBaseUrl, layerId, 5); } catch {}

    // Fetch total record count for sample records display
    let recordCount = null;
    try {
      const countParams = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
      const countTarget = isLayerUrl ? fetchBaseUrl : `${fetchBaseUrl}/${layerId}`;
      const countJson = await fetchJsonWithTimeout(`${countTarget}/query?${countParams}`, 5000);
      if (countJson && typeof countJson.count === 'number') recordCount = countJson.count;
    } catch {}

    // Bail if user navigated to a different dataset while we were fetching
    if (generation !== _renderGeneration) return;

    // Service description from metadata
    const serviceDescription = serviceJson.serviceDescription || serviceJson.description || '';
    const copyrightText = serviceJson.copyrightText || '';
    const documentInfo = serviceJson.documentInfo || {};
    const currentVersion = serviceJson.currentVersion || '';
    const maxRecordCount = serviceJson.maxRecordCount || '';
    
    // Additional metadata from service/layer JSON
    const spatialRef = serviceJson.spatialReference || layerJson?.spatialReference || {};
    const wkid = spatialRef.latestWkid || spatialRef.wkid || '';
    const capabilities = serviceJson.capabilities || '';
    const supportsStatistics = layerJson?.supportsStatistics ?? serviceJson.supportsStatistics ?? null;
    const supportsAdvancedQueries = layerJson?.advancedQueryCapabilities?.supportsAdvancedQueries ?? null;
    const geometryType = layerJson?.geometryType || '';
    const objectIdField = layerJson?.objectIdField || '';
    const globalIdField = layerJson?.globalIdField || '';
    const displayField = layerJson?.displayField || '';
    const hasAttachments = layerJson?.hasAttachments ?? null;
    const hasM = layerJson?.hasM ?? null;
    const hasZ = layerJson?.hasZ ?? null;
    const minScale = layerJson?.minScale || 0;
    const maxScale = layerJson?.maxScale || 0;
    const editFieldsInfo = layerJson?.editFieldsInfo || null;
    const featureCount = layerJson?.featureCount ?? null; // sometimes available
    const extent = layerJson?.extent || serviceJson.fullExtent || null;

    let html = '';

    // Service Metadata from REST endpoint
    html += `
      <div class="card" style="margin-top:0.75rem;">
        <div class="card-header-row"><div style="font-weight:600;">Service Metadata</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
        <p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">Fetched from the ArcGIS REST endpoint</p>
        
        ${serviceDescription 
          ? `<div class="collapsible-text-container">
               <p><strong>Description:</strong></p>
               <div class="collapsible-text ${serviceDescription.length > 300 ? 'is-collapsed' : ''}" data-full-text="${escapeHtml(serviceDescription)}">
                 ${escapeHtml(serviceDescription)}
               </div>
               ${serviceDescription.length > 300 ? '<button type="button" class="show-more-btn" data-toggle-collapse>Show more</button>' : ''}
             </div>` 
          : `<p class="metadata-missing"><strong>Description:</strong> <em>Not provided by service</em></p>`
        }
        
        ${copyrightText 
          ? `<p><strong>Copyright:</strong> ${escapeHtml(copyrightText)}</p>` 
          : `<p class="metadata-missing"><strong>Copyright:</strong> <em>Not provided by service</em></p>`
        }
        ${documentInfo.Author 
          ? `<p><strong>Author:</strong> ${escapeHtml(documentInfo.Author)}</p>` 
          : `<p class="metadata-missing"><strong>Author:</strong> <em>Not provided by service</em></p>`
        }
        
        <div class="metadata-grid">
          ${currentVersion 
            ? `<div class="metadata-item"><span class="metadata-label">Server Version</span><span class="metadata-value">${escapeHtml(String(currentVersion))}</span></div>` 
            : ''
          }
          ${wkid 
            ? `<div class="metadata-item"><span class="metadata-label">Spatial Reference</span><span class="metadata-value">EPSG:${escapeHtml(String(wkid))}</span></div>` 
            : ''
          }
          ${geometryType 
            ? `<div class="metadata-item"><span class="metadata-label">Geometry Type</span><span class="metadata-value">${escapeHtml(geometryType.replace('esriGeometry', ''))}</span></div>` 
            : ''
          }
          ${maxRecordCount 
            ? `<div class="metadata-item"><span class="metadata-label">Max Record Count</span><span class="metadata-value">${Number(maxRecordCount).toLocaleString()}</span></div>` 
            : ''
          }
          ${featureCount !== null 
            ? `<div class="metadata-item"><span class="metadata-label">Feature Count</span><span class="metadata-value">${Number(featureCount).toLocaleString()}</span></div>` 
            : ''
          }
          ${objectIdField 
            ? `<div class="metadata-item"><span class="metadata-label">Object ID Field</span><span class="metadata-value"><code>${escapeHtml(objectIdField)}</code></span></div>` 
            : ''
          }
          ${globalIdField 
            ? `<div class="metadata-item"><span class="metadata-label">Global ID Field</span><span class="metadata-value"><code>${escapeHtml(globalIdField)}</code></span></div>` 
            : ''
          }
          ${displayField 
            ? `<div class="metadata-item"><span class="metadata-label">Display Field</span><span class="metadata-value"><code>${escapeHtml(displayField)}</code></span></div>` 
            : ''
          }
        </div>
        
        <div class="metadata-capabilities">
          ${capabilities 
            ? `<p><strong>Capabilities:</strong> ${capabilities.split(',').map(c => `<span class="capability-pill">${escapeHtml(c.trim())}</span>`).join(' ')}</p>` 
            : ''
          }
          <div class="capability-flags">
            ${supportsStatistics !== null 
              ? `<span class="capability-flag ${supportsStatistics ? 'is-supported' : 'is-not-supported'}">${supportsStatistics ? '✓' : '✗'} Statistics</span>` 
              : ''
            }
            ${supportsAdvancedQueries !== null 
              ? `<span class="capability-flag ${supportsAdvancedQueries ? 'is-supported' : 'is-not-supported'}">${supportsAdvancedQueries ? '✓' : '✗'} Advanced Queries</span>` 
              : ''
            }
            ${hasAttachments !== null 
              ? `<span class="capability-flag ${hasAttachments ? 'is-supported' : 'is-not-supported'}">${hasAttachments ? '✓' : '✗'} Attachments</span>` 
              : ''
            }
            ${hasZ !== null 
              ? `<span class="capability-flag ${hasZ ? 'is-supported' : 'is-not-supported'}">${hasZ ? '✓' : '✗'} Z Values</span>` 
              : ''
            }
            ${hasM !== null 
              ? `<span class="capability-flag ${hasM ? 'is-supported' : 'is-not-supported'}">${hasM ? '✓' : '✗'} M Values</span>` 
              : ''
            }
            ${editFieldsInfo 
              ? `<span class="capability-flag is-supported">✓ Editor Tracking</span>` 
              : ''
            }
          </div>
        </div>
        
        ${(minScale > 0 || maxScale > 0) 
          ? `<p><strong>Visibility Scale Range:</strong> ${maxScale > 0 ? '1:' + Number(maxScale).toLocaleString() : 'Any'} – ${minScale > 0 ? '1:' + Number(minScale).toLocaleString() : 'Any'}</p>` 
          : ''
        }
        
        ${extent && extent.xmin !== undefined 
          ? `<details class="extent-details">
               <summary><strong>Full Extent</strong></summary>
               <div class="extent-coords">
                 <span>xmin: ${extent.xmin?.toFixed(4)}</span>
                 <span>ymin: ${extent.ymin?.toFixed(4)}</span>
                 <span>xmax: ${extent.xmax?.toFixed(4)}</span>
                 <span>ymax: ${extent.ymax?.toFixed(4)}</span>
               </div>
             </details>` 
          : ''
        }
      </div>
    `;

    // Interactive ArcGIS Map View (skip for non-spatial tables)
    const mapServiceUrl = url;
    const mapLayerId = layerId;
    const _isTable = !geometryType || geometryType.toUpperCase() === 'TABLE';
    if (!_isTable) {
      html += `
        <div class="card" style="margin-top:0.75rem;">
          <div class="card-header-row"><div style="font-weight:600;">Interactive Map</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
          <div style="color:var(--text-muted); margin-bottom:0.5rem; font-size:0.9rem;">Pan and zoom to explore the dataset</div>
          <div id="arcgisMapContainer" 
               data-service-url="${escapeHtml(mapServiceUrl)}" 
               data-layer-id="${mapLayerId}"
               style="width:100%; height:400px; border-radius:12px; overflow:hidden; background:#e0e0e0;"></div>
        </div>
      `;
    }

    // Fields summary — redesigned as a table with async null% / unique% stats
    if (layerJson && Array.isArray(layerJson.fields) && layerJson.fields.length) {
      const allFields = layerJson.fields;

      // Identify key / system fields
      const oidField = (layerJson.objectIdField || '').toUpperCase();
      const globalIdField = (layerJson.globalIdField || '').toUpperCase();
      function isKeyField(f) {
        const n = (f.name || '').toUpperCase();
        const t = (f.type || '').toUpperCase();
        return n === oidField || n === globalIdField
          || t === 'ESRIFIELDTYPEOID' || t === 'ESRIFIELDTYPEGLOBALID';
      }

      // Friendly type labels
      function friendlyType(esriType) {
        const map = {
          'ESRIFIELDTYPEOID':       'OID',
          'ESRIFIELDTYPEGLOBALID':  'GlobalID',
          'ESRIFIELDTYPESTRING':    'String',
          'ESRIFIELDTYPEINTEGER':   'Integer',
          'ESRIFIELDTYPESMALLINTEGER': 'SmallInt',
          'ESRIFIELDTYPEDOUBLE':    'Double',
          'ESRIFIELDTYPESINGLE':    'Single',
          'ESRIFIELDTYPEDATE':      'Date',
          'ESRIFIELDTYPEBLOB':      'Blob',
          'ESRIFIELDTYPEGUID':      'GUID',
          'ESRIFIELDTYPEXML':       'XML',
          'ESRIFIELDTYPEGEOMETRY':  'Geometry',
          'ESRIFIELDTYPERASTER':    'Raster',
        };
        const key = String(esriType || '').toUpperCase().replace(/\s/g, '');
        return map[key] || esriType || '';
      }

      html += `
        <div class="card card-fields" style="margin-top:0.75rem;">
          <div class="card-header-row"><div style="font-weight:600;">Fields</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
          <p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">${allFields.length} fields. Null % and Distinct counts are computed from the full dataset via service statistics queries.</p>
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
                ${allFields.map((f, i) => {
                  const key = isKeyField(f);
                  const hasDomain = f.domain && f.domain.type === 'codedValue';
                  const rowCls = key ? ' class="field-row-key"' : (hasDomain ? ' class="field-row-domain"' : '');
                  const badge = key ? '<span class="field-key-badge">KEY</span>' : (hasDomain ? '<span class="field-domain-badge">DOMAIN</span>' : '');
                  return `<tr${rowCls} data-field-idx="${i}">
                    <td class="field-name-cell">${badge}<code>${escapeHtml(f.name)}</code></td>
                    <td>${escapeHtml(f.alias || '')}</td>
                    <td><span class="field-type-pill">${escapeHtml(friendlyType(f.type))}</span></td>
                    <td class="fields-stat-col" data-field-null="${i}"><span class="field-stat-loading">\u2022\u2022\u2022</span></td>
                    <td class="fields-stat-col" data-field-uniq="${i}"><span class="field-stat-loading">\u2022\u2022\u2022</span></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // --- Async field stats: runs after card renders ---
      // We capture variables for the async closure
      const _fieldStatsUrl = fetchBaseUrl;
      const _fieldStatsLayerId = layerId;
      const _fieldStatsFields = allFields;
      const _fieldStatsGen = generation;

      // Defer to next microtask so the DOM is painted first
      setTimeout(async () => {
        if (_fieldStatsGen !== _renderGeneration) return;
        const table = contentEl.querySelector('#fieldsTable');
        if (!table) return;

        // 1) Get total feature count
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
          // Can't compute percentages without total count — show dashes
          table.querySelectorAll('[data-field-null], [data-field-uniq]').forEach(td => {
            td.textContent = '\u2014';
          });
          return;
        }

        // 2) Query null count and distinct count per field (batched with concurrency limit)
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

            // Skip geometry/blob/raster fields
            const ft = (f.type || '').toUpperCase();
            if (ft.includes('GEOMETRY') || ft.includes('BLOB') || ft.includes('RASTER') || ft.includes('XML')) {
              nullCell.textContent = '\u2014';
              uniqCell.textContent = '\u2014';
              continue;
            }

            try {
              // COUNT(fieldName) gives non-null count
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
              nullCell.innerHTML = nullPct > 0
                ? `<span class="field-stat-bar" style="--pct:${Math.min(nullPct, 100).toFixed(0)}%">${nullPct.toFixed(1)}%</span>`
                : '<span class="field-stat-zero">0%</span>';
            } catch {
              nullCell.textContent = '\u2014';
            }

            try {
              // Distinct count: try multiple approaches for compatibility
              const base = normalizeServiceUrl(_fieldStatsUrl);
              const parsed = parseServiceAndLayerId(base);
              const target = parsed.isLayerUrl ? base : `${base}/${_fieldStatsLayerId}`;
              
              let distinctCount = null;
              
              // Approach 1: returnDistinctValues with returnCountOnly (cleaner, but not always supported)
              try {
                const distParams1 = new URLSearchParams({
                  where: '1=1',
                  outFields: f.name,
                  returnDistinctValues: 'true',
                  returnCountOnly: 'true',
                  f: 'json',
                });
                const distJson1 = await fetchJsonWithTimeout(`${target}/query?${distParams1}`, 5000);
                if (distJson1 && typeof distJson1.count === 'number') {
                  distinctCount = distJson1.count;
                }
              } catch {}
              
              // Approach 2: If approach 1 failed, use groupByFieldsForStatistics and count features
              if (distinctCount === null) {
                try {
                  const distParams2 = new URLSearchParams({
                    where: '1=1',
                    groupByFieldsForStatistics: f.name,
                    outStatistics: JSON.stringify([
                      { statisticType: 'count', onStatisticField: f.name, outStatisticFieldName: 'cnt' }
                    ]),
                    f: 'json',
                  });
                  const distJson2 = await fetchJsonWithTimeout(`${target}/query?${distParams2}`, 5000);
                  if (distJson2 && Array.isArray(distJson2.features)) {
                    distinctCount = distJson2.features.length;
                  }
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
      }, 50);
    }

    // Sample table
    if (sampleJson && Array.isArray(sampleJson.features) && sampleJson.features.length) {
      const rows = sampleJson.features.map(ft => ft.attributes || {}).slice(0, 5);
      const cols = Object.keys(rows[0] || {}); // show all columns
      const recordCountText = recordCount !== null ? `${recordCount.toLocaleString()} total records in service.` : '';
      if (cols.length) {
        html += `
          <div class="card" style="margin-top:0.75rem;">
            <div class="card-header-row"><div style="font-weight:600;">Sample Records</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
            <p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">${recordCountText} Showing ${rows.length} randomly selected rows.</p>
            <div style="overflow:auto;">
              <table>
                <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
                <tbody>
                  ${rows.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }
    }

    contentEl.innerHTML = html;
    statusEl.textContent = 'Preview loaded.';

    // Initialize interactive ArcGIS map (use service root for MapImageLayer)
    // Skip for non-spatial tables — there is no geometry to display.
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
