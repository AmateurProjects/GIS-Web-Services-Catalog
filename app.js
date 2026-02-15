// app.js

// ====== UI FX HELPERS ======
 function animatePanel(el, durationMs = 650) {
   if (!el) return;

   // Hide scrollbars globally during the animation (prevents transient page scrollbars)
   document.documentElement.classList.add('fx-no-scroll');
   document.body.classList.add('fx-no-scroll');
   el.classList.add('fx-animating');

   // Re-trigger CSS animation by toggling a class
   el.classList.remove('fx-enter');
   void el.offsetWidth; // Force reflow so the browser restarts the animation
   el.classList.add('fx-enter');

   // Always clean up (animationend may fire on child cards, not on the panel itself)
   window.setTimeout(() => {
     el.classList.remove('fx-animating');
     document.documentElement.classList.remove('fx-no-scroll');
     document.body.classList.remove('fx-no-scroll');
   }, durationMs);
 }


 // Adds stagger classes to the first N cards inside a panel
 function staggerCards(panelEl, maxCards = 9) {
   if (!panelEl) return;
   const cards = panelEl.querySelectorAll('.card, .detail-section');
   // clear old delay classes
   cards.forEach((c) => {
     for (let i = 1; i <= 9; i++) c.classList.remove(`fx-d${i}`);
   });
   // assign new delay classes
   cards.forEach((c, idx) => {
     const n = Math.min(idx + 1, maxCards);
     c.classList.add(`fx-d${n}`);
   });
 }



 function setActiveListButton(listRootEl, predicateFn) {
   if (!listRootEl) return;
   const btns = listRootEl.querySelectorAll('button.list-item-button');
   btns.forEach((b) => {
     const isActive = predicateFn(b);
     b.classList.toggle('is-active', isActive);
   });
 }


// ====== URL STATUS CHECK HELPERS ======
const URL_CHECK = {
  timeoutMs: 3500,
  concurrency: 3,
};

// Cache URL check results for this browser session (page lifetime)
// url -> { status: "ok"|"bad"|"unknown", ts: number }
const urlStatusCache = new Map();

function getCachedUrlStatus(url) {
  if (!url) return null;
  return urlStatusCache.get(url) || null;
}

function setCachedUrlStatus(url, status) {
  if (!url) return;
  urlStatusCache.set(url, { status, ts: Date.now() });
}

function setUrlStatus(rowEl, status, titleText) {
  if (!rowEl) return;
  rowEl.setAttribute('data-url-status', status);
  const icon = rowEl.querySelector('.url-status-icon');
  if (icon) icon.title = titleText || '';
}

// Tries to determine if a URL is reachable.
// Returns: "ok" | "bad" | "unknown"
async function checkUrlStatus(url) {
  if (!url) return 'bad';
  const cached = getCachedUrlStatus(url);
  if (cached && cached.status) return cached.status;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bad';
  } catch {
    return 'bad';
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), URL_CHECK.timeoutMs);

  try {
    // Try HEAD first (fast + minimal payload)
    let resp = await fetch(url, {
      method: 'HEAD',
      mode: 'cors',
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });

    // If CORS blocks reading status, some browsers throw; if not, use status.
    if (resp && typeof resp.status === 'number') {
      const s = (resp.status >= 200 && resp.status < 400) ? 'ok' : 'bad';
      setCachedUrlStatus(url, s);
      return s;
    }
    setCachedUrlStatus(url, 'unknown');
    return 'unknown';
  } catch (e1) {
    // Fallback: no-cors GET gives opaque response (still indicates network likely worked)
    try {
      let resp2 = await fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        redirect: 'follow',
        signal: controller.signal,
        cache: 'no-store',
      });
      // opaque response => cannot verify status, but request likely reached the server
      if (resp2 && resp2.type === 'opaque') {
        setCachedUrlStatus(url, 'unknown');
        return 'unknown';
      }
      // if somehow we got a normal response here, treat 2xx/3xx as ok
      if (resp2 && typeof resp2.status === 'number') {
        const s2 = (resp2.status >= 200 && resp2.status < 400) ? 'ok' : 'bad';
        setCachedUrlStatus(url, s2);
        return s2;
      }
      setCachedUrlStatus(url, 'unknown');
      return 'unknown';
    } catch (e2) {
      setCachedUrlStatus(url, 'bad');
      return 'bad';
    }
  } finally {
    clearTimeout(t);
  }
}

async function runUrlChecks(hostEl) {
  if (!hostEl) return;
  const rows = Array.from(hostEl.querySelectorAll('[data-url-check-row]'));
  if (!rows.length) return;

  // If cached, paint immediately. Otherwise mark as checking.
  const toCheck = [];
  rows.forEach((row) => {
    const url = row.getAttribute('data-url') || '';
    if (!url) {
      setUrlStatus(row, 'bad', 'Missing/invalid URL');
      return;
    }
    const cached = getCachedUrlStatus(url);
    if (cached && cached.status) {
      const title =
        cached.status === 'ok'
          ? 'Link looks reachable (cached)'
          : cached.status === 'bad'
          ? 'Link appears unreachable/invalid (cached)'
          : 'Cannot verify (cached), click to test';
      setUrlStatus(row, cached.status, title);
    } else {
      setUrlStatus(row, 'checking', 'Checking link…');
      toCheck.push(row);
    }
  });

  if (!toCheck.length) return;

  let idx = 0;
  const workers = new Array(URL_CHECK.concurrency).fill(0).map(async () => {
    while (idx < toCheck.length) {
      const row = toCheck[idx++];
      const url = row.getAttribute('data-url') || '';
      const result = await checkUrlStatus(url);
      if (result === 'ok') setUrlStatus(row, 'ok', 'Link looks reachable');
      else if (result === 'bad') setUrlStatus(row, 'bad', 'Link appears unreachable/invalid');
      else setUrlStatus(row, 'unknown', 'Cannot verify (CORS/blocked), click to test');
    }
  });

  await Promise.all(workers);
}

// ====== ARCGIS REST PREVIEW HELPERS (static image + metadata + sample) ======

function normalizeServiceUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  return u.replace(/\/+$/, '');
}

/**
 * Parse an ArcGIS REST URL into its service base and (optional) layer id.
 *   • .../FeatureServer/3  → { serviceUrl: '.../FeatureServer', layerId: 3, isLayerUrl: true }
 *   • .../MapServer         → { serviceUrl: '.../MapServer',    layerId: null, isLayerUrl: false }
 */
function parseServiceAndLayerId(rawUrl) {
  const url = normalizeServiceUrl(rawUrl);
  // Match trailing /MapServer/0, /FeatureServer/12, /ImageServer/3 etc.
  const m = url.match(/^(.*\/(?:MapServer|FeatureServer|ImageServer))\/([0-9]+)$/i);
  if (m) {
    return { serviceUrl: m[1], layerId: Number(m[2]), isLayerUrl: true };
  }
  return { serviceUrl: url, layerId: null, isLayerUrl: false };
}

function looksLikeArcGisService(url) {
  const u = String(url || '').toUpperCase();
  // ArcGIS Server can be deployed at any context path (not just /arcgis/)
  // Common patterns: /arcgis/rest/services/, /nlsdb/rest/services/, /gis/rest/services/
  // The reliable marker is /rest/services/ combined with a service type endpoint
  return u.includes('/REST/SERVICES/') && (u.includes('/MAPSERVER') || u.includes('/FEATURESERVER') || u.includes('/IMAGESERVER'));
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
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

async function fetchServiceJson(serviceUrl) {
  const base = normalizeServiceUrl(serviceUrl);
  const u = base.includes('?') ? `${base}&f=pjson` : `${base}?f=pjson`;
  return fetchJsonWithTimeout(u);
}

async function fetchLayerJson(serviceUrl, layerId = 0) {
  const base = normalizeServiceUrl(serviceUrl);
  // If the URL already points to a layer endpoint, use it directly
  const parsed = parseServiceAndLayerId(base);
  const target = parsed.isLayerUrl ? base : `${base}/${layerId}`;
  const u = `${target}?f=pjson`;
  return fetchJsonWithTimeout(u);
}

async function fetchSampleRows(serviceUrl, layerId = 0, n = 8) {
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
let currentMapView = null;

// Render generation counter — incremented each time renderDatasetDetail is called.
// Async operations (preview, coverage map) check this to avoid painting into stale DOM.
let _renderGeneration = 0;
function initializeArcGISMap(serviceUrl, layerId) {
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
        basemap: "topo-vector",
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

async function maybeRenderPublicServicePreviewCard(hostEl, publicUrl, generation) {
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

    // Bail if user navigated to a different dataset while we were fetching
    if (generation !== _renderGeneration) return;

    // Service description from metadata
    const serviceDescription = serviceJson.serviceDescription || serviceJson.description || '';
    const copyrightText = serviceJson.copyrightText || '';
    const documentInfo = serviceJson.documentInfo || {};
    const currentVersion = serviceJson.currentVersion || '';
    const maxRecordCount = serviceJson.maxRecordCount || '';

    let html = '';

    // Service Metadata from REST endpoint
    html += `
      <div class="card" style="margin-top:0.75rem;">
        <div class="card-header-row"><div style="font-weight:600;">Service Metadata</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
        <p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">Fetched from the ArcGIS REST endpoint</p>
        ${serviceDescription 
          ? `<p><strong>Description:</strong> ${escapeHtml(serviceDescription)}</p>` 
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
        ${currentVersion 
          ? `<p><strong>ArcGIS Server Version:</strong> ${escapeHtml(String(currentVersion))}</p>` 
          : ''
        }
        ${maxRecordCount 
          ? `<p><strong>Max Record Count:</strong> ${escapeHtml(String(maxRecordCount))}</p>` 
          : ''
        }
      </div>
    `;

    // Interactive ArcGIS Map View
    const mapServiceUrl = url;
    const mapLayerId = layerId;
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
          <div class="card-header-row"><div style="font-weight:600;">Fields (layer ${escapeHtml(String(layerId))})</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
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
              // Distinct count via groupByFieldsForStatistics (count unique values)
              const base = normalizeServiceUrl(_fieldStatsUrl);
              const parsed = parseServiceAndLayerId(base);
              const target = parsed.isLayerUrl ? base : `${base}/${_fieldStatsLayerId}`;
              const distParams = new URLSearchParams({
                where: '1=1',
                outFields: f.name,
                groupByFieldsForStatistics: f.name,
                outStatistics: JSON.stringify([
                  { statisticType: 'count', onStatisticField: f.name, outStatisticFieldName: 'grp_count' }
                ]),
                returnCountOnly: 'true',
                f: 'json',
              });
              const distJson = await fetchJsonWithTimeout(`${target}/query?${distParams}`, 6000);
              const distinctCount = (distJson && typeof distJson.count === 'number') ? distJson.count : null;
              if (distinctCount != null && totalCount > 0) {
                const isUnique = distinctCount === totalCount;
                const hasDomain = f.domain && f.domain.type === 'codedValue';
                if (isUnique) {
                  uniqCell.innerHTML = `<span class="field-stat-unique">${distinctCount.toLocaleString()} \u2713</span>`;
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
      const cols = Object.keys(rows[0] || {}).slice(0, 10); // keep table compact
      if (cols.length) {
        html += `
          <div class="card" style="margin-top:0.75rem;">
            <div class="card-header-row"><div style="font-weight:600;">Sample Records (layer ${escapeHtml(String(layerId))})</div><span class="data-source-badge data-source-badge-auto">Auto</span></div>
            <p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">Rows are randomly selected from the service and may not be representative of the full dataset.</p>
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
    initializeArcGISMap(serviceBaseUrl, layerId);

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




// ====== COVERAGE MAP (State-level Intersection Analysis via Census Bureau) ======

const CENSUS_STATES_SERVICE =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0';
const COVERAGE_CONCURRENCY = 4;

// 50 US states + DC  (FIPS codes)
const US_STATE_FIPS = new Set([
  '01','02','04','05','06','08','09','10','11','12','13','15','16','17','18','19','20',
  '21','22','23','24','25','26','27','28','29','30','31','32','33','34','35','36','37',
  '38','39','40','41','42','44','45','46','47','48','49','50','51','53','54','55','56'
]);

// Session caches
let _censusStatesCache = null;
const _coverageAnalysisCache = new Map();

// ── ArcGIS SDK query modules (loaded on-demand for coverage analysis) ──
let _esriQuery = null;
let _EsriQueryClass = null;
let _geometryEngine = null;

function _loadCoverageQueryModules() {
  return new Promise((resolve, reject) => {
    if (_esriQuery && _EsriQueryClass && _geometryEngine) { resolve(); return; }
    if (typeof require === 'undefined') {
      reject(new Error('ArcGIS JS SDK not loaded'));
      return;
    }
    require([
      'esri/rest/query',
      'esri/rest/support/Query',
      'esri/geometry/geometryEngine'
    ], (queryMod, QueryClass, geomEngine) => {
      _esriQuery = queryMod;
      _EsriQueryClass = QueryClass;
      _geometryEngine = geomEngine;
      resolve();
    }, reject);
  });
}

/**
 * Fetch generalized state boundaries from the Census Bureau TIGERweb service
 * using the ArcGIS JS SDK query module. Results are cached for the page session.
 */
async function fetchCensusStateBoundaries() {
  if (_censusStatesCache) return _censusStatesCache;

  await _loadCoverageQueryModules();

  const query = new _EsriQueryClass({
    where:              '1=1',
    outFields:          ['STATE', 'NAME', 'STUSAB'],
    returnGeometry:     true,
    outSpatialReference: { wkid: 4326 },
    geometryPrecision:  2,
    maxAllowableOffset: 0.05,
    num:                60,
  });

  const featureSet = await _esriQuery.executeQueryJSON(
    CENSUS_STATES_SERVICE, query, { timeout: 25000 }
  );

  if (!featureSet || !Array.isArray(featureSet.features) || !featureSet.features.length) {
    throw new Error('Census state boundary query returned no features');
  }

  // Normalize field names (Census can vary between NAME / name etc.)
  function attr(f, ...keys) {
    for (const k of keys) {
      if (f.attributes[k] !== undefined) return f.attributes[k];
      if (f.attributes[k.toUpperCase()] !== undefined) return f.attributes[k.toUpperCase()];
    }
    return '';
  }

  const states = featureSet.features
    .map(f => ({
      fips: String(attr(f, 'STATE', 'STATEFP', 'GEOID')).padStart(2, '0'),
      name: attr(f, 'NAME'),
      abbr: attr(f, 'STUSAB'),
      geometry: f.geometry, // esri/geometry/Polygon — has .rings for SVG rendering
    }))
    .filter(s => US_STATE_FIPS.has(s.fips) && s.geometry && s.geometry.rings);

  _censusStatesCache = states;
  return states;
}

/**
 * Query a dataset's feature service for the count of features that intersect
 * a given polygon geometry (one state boundary) using the ArcGIS JS SDK.
 * A small inward buffer (-2 km) is applied to the state polygon to exclude
 * sliver intersections along shared borders.
 */
async function queryFeatureCountInGeometry(serviceUrl, layerId, geometry) {
  await _loadCoverageQueryModules();

  const base = normalizeServiceUrl(serviceUrl);
  const parsed = parseServiceAndLayerId(base);
  const target = parsed.isLayerUrl ? base : `${base}/${layerId}`;

  // Negative geodesic buffer shrinks the polygon inward by 2 km,
  // eliminating thin slivers at state boundaries from being counted.
  const buffered = _geometryEngine.geodesicBuffer(geometry, -2, 'kilometers');

  // If the buffer collapses the polygon entirely (tiny island/territory),
  // fall back to the original geometry.
  const queryGeom = (buffered && buffered.rings && buffered.rings.length) ? buffered : geometry;

  const query = new _EsriQueryClass({
    where:               '1=1',
    geometry:            queryGeom,
    spatialRelationship: 'intersects',
  });

  return await _esriQuery.executeForCount(target, query, { timeout: 10000 });
}

/**
 * Run the coverage analysis across all states with a concurrency pool.
 * Calls onProgress(completed, total) after each state finishes.
 */
async function runCoverageAnalysis(serviceUrl, layerId, states, onProgress) {
  const results = [];
  let idx = 0;

  const workers = Array.from({ length: COVERAGE_CONCURRENCY }, async () => {
    while (idx < states.length) {
      const i = idx++;
      const state = states[i];
      let count;
      try {
        count = await queryFeatureCountInGeometry(serviceUrl, layerId, state.geometry);
      } catch {
        count = -1; // error
      }
      results.push({ ...state, count });
      if (onProgress) onProgress(results.length, states.length);
    }
  });

  await Promise.all(workers);
  return results;
}

// ── SVG map rendering helpers ──

function projectGeoToSVG(lon, lat, geoBounds, viewport) {
  const x = viewport.x + ((lon - geoBounds.minLon) / (geoBounds.maxLon - geoBounds.minLon)) * viewport.w;
  const y = viewport.y + (1 - (lat - geoBounds.minLat) / (geoBounds.maxLat - geoBounds.minLat)) * viewport.h;
  return [x, y];
}

function polygonRingsToPath(rings, geoBounds, viewport) {
  if (!rings || !rings.length) return '';
  return rings.map(ring => {
    if (!ring || ring.length < 3) return '';
    const pts = ring.map(([lon, lat]) => {
      const [x, y] = projectGeoToSVG(lon, lat, geoBounds, viewport);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return 'M' + pts.join('L') + 'Z';
  }).join('');
}

/**
 * Compute a visually centered label point for a polygon.
 * Uses the signed-area centroid of the largest ring, then clamps it
 * inside that ring's bounding box so labels stay within the state.
 */
function polygonLabelPoint(rings) {
  if (!rings || !rings.length) return [0, 0];

  // Find the ring with the largest absolute area (outer ring)
  let bestRing = rings[0];
  let bestArea = 0;
  rings.forEach(ring => {
    if (!ring || ring.length < 3) return;
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % n];
      a += x0 * y1 - x1 * y0;
    }
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      bestRing = ring;
    }
  });

  // Signed-area centroid of the largest ring
  let cx = 0, cy = 0, totalA = 0;
  for (let i = 0, n = bestRing.length; i < n; i++) {
    const [x0, y0] = bestRing[i];
    const [x1, y1] = bestRing[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
    totalA += cross;
  }
  if (Math.abs(totalA) > 1e-10) {
    cx /= (3 * totalA);
    cy /= (3 * totalA);
  } else {
    // Degenerate — fall back to simple average
    cx = 0; cy = 0;
    bestRing.forEach(([lon, lat]) => { cx += lon; cy += lat; });
    cx /= bestRing.length;
    cy /= bestRing.length;
  }

  // Clamp into the ring's bounding box with 15% inset to avoid edges
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  bestRing.forEach(([lon, lat]) => {
    if (lon < minX) minX = lon;
    if (lon > maxX) maxX = lon;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  });
  const padX = (maxX - minX) * 0.15;
  const padY = (maxY - minY) * 0.15;
  cx = Math.max(minX + padX, Math.min(maxX - padX, cx));
  cy = Math.max(minY + padY, Math.min(maxY - padY, cy));

  return [cx, cy];
}

/**
 * Build a complete coverage map SVG showing the US with Alaska/Hawaii insets.
 * States with features are given a solid blue fill; others are dark gray.
 */
function buildCoverageMapSVG(analysisResults) {
  const W = 960, H = 620;

  // Geographic bounds & SVG viewports
  const conus = { minLon: -125, maxLon: -66, minLat: 24.3, maxLat: 49.5 };
  const conusVP = { x: 0, y: 0, w: W, h: H * 0.82 };

  const ak = { minLon: -190, maxLon: -130, minLat: 51, maxLat: 72 };
  const akVP = { x: 10, y: H * 0.68, w: W * 0.24, h: H * 0.28 };

  const hi = { minLon: -161, maxLon: -154, minLat: 18.5, maxLat: 22.5 };
  const hiVP = { x: W * 0.26, y: H * 0.80, w: W * 0.12, h: H * 0.16 };

  // Color scale (logarithmic for better visual distribution)
  const maxCount = Math.max(...analysisResults.map(s => s.count).filter(c => c > 0), 1);

  function stateColor(count) {
    if (count <= 0) return 'rgba(255,255,255,0.12)';
    const t = Math.min(1, Math.log(count + 1) / Math.log(maxCount + 1));
    // Light blue → deep blue gradient
    const r = Math.round(30 + (1 - t) * 40);
    const g = Math.round(80 + (1 - t) * 80);
    const b = Math.round(140 + t * 115);
    const a = 0.5 + t * 0.45;
    return `rgba(${r},${g},${b},${a})`;
  }

  let pathsHtml = '';
  let labelsHtml = '';

  analysisResults.forEach(state => {
    if (!state.geometry || !state.geometry.rings) return;

    const isAK = state.fips === '02';
    const isHI = state.fips === '15';
    const bounds = isAK ? ak : isHI ? hi : conus;
    const vp     = isAK ? akVP : isHI ? hiVP : conusVP;

    const d = polygonRingsToPath(state.geometry.rings, bounds, vp);
    if (!d) return;

    const fill = stateColor(state.count);
    const stroke = state.count > 0 ? 'rgba(91,163,245,0.6)' : 'rgba(255,255,255,0.3)';
    const title  = `${escapeHtml(state.name)}: ${state.count >= 0 ? state.count.toLocaleString() + ' features' : 'query failed'}`;

    pathsHtml += `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"
      fill-rule="evenodd" data-state="${escapeHtml(state.abbr)}" data-count="${state.count}">
      <title>${title}</title></path>\n`;

    // Count label for states with data
    if (state.count > 0) {
      const [clon, clat] = polygonLabelPoint(state.geometry.rings);
      const [sx, sy] = projectGeoToSVG(clon, clat, bounds, vp);
      const countStr = state.count >= 1000
        ? (state.count / 1000).toFixed(state.count >= 10000 ? 0 : 1) + 'k'
        : String(state.count);
      labelsHtml += `<text x="${sx.toFixed(0)}" y="${(sy - 2).toFixed(0)}" class="cov-count">${countStr}</text>\n`;
      labelsHtml += `<text x="${sx.toFixed(0)}" y="${(sy + 12).toFixed(0)}" class="cov-abbr">${escapeHtml(state.abbr)}</text>\n`;
    }
  });

  // Inset outlines & labels
  const insetsHtml = `
    <rect x="${akVP.x}" y="${akVP.y}" width="${akVP.w}" height="${akVP.h}"
          fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1" rx="6"/>
    <text x="${akVP.x + 6}" y="${akVP.y + 14}" class="cov-inset-label">Alaska</text>
    <rect x="${hiVP.x}" y="${hiVP.y}" width="${hiVP.w}" height="${hiVP.h}"
          fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1" rx="6"/>
    <text x="${hiVP.x + 6}" y="${hiVP.y + 14}" class="cov-inset-label">Hawaii</text>
  `;

  // Summary stats
  const statesWithData = analysisResults.filter(s => s.count > 0).length;
  const totalFeatures  = analysisResults.reduce((sum, s) => sum + Math.max(0, s.count), 0);
  const failedCount    = analysisResults.filter(s => s.count === -1).length;

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="coverage-map-svg"
    xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <g>${pathsHtml}</g>
    <g>${labelsHtml}</g>
    ${insetsHtml}
  </svg>`;

  return { svg, statesWithData, totalFeatures, totalStates: analysisResults.length, failedCount };
}

/**
 * Main entry-point: renders the coverage map card inside a host element.
 * The host element must contain #coverageMapCard with [data-cov-status]
 * and [data-cov-content] children.
 */
async function renderCoverageMapCard(hostEl, publicServiceUrl, generation) {
  if (!hostEl) return;
  const card = hostEl.querySelector('#coverageMapCard');
  if (!card) return;

  const statusEl  = card.querySelector('[data-cov-status]');
  const contentEl = card.querySelector('[data-cov-content]');
  if (!statusEl || !contentEl) return;

  const url = normalizeServiceUrl(publicServiceUrl);
  if (!url) {
    statusEl.textContent = 'No public web service URL available for coverage analysis.';
    return;
  }
  if (!looksLikeArcGisService(url)) {
    statusEl.textContent = 'Coverage analysis requires an ArcGIS REST Map/Feature service.';
    return;
  }

  // Determine the layer id from the URL
  const parsed = parseServiceAndLayerId(url);
  const layerId = parsed.isLayerUrl ? parsed.layerId : 0;

  // Check cache
  const cacheKey = `${url}__${layerId}`;
  if (_coverageAnalysisCache.has(cacheKey)) {
    const cached = _coverageAnalysisCache.get(cacheKey);
    paintCoverageResult(statusEl, contentEl, cached);
    return;
  }

  // Step 1 — fetch state boundaries
  statusEl.textContent = 'Fetching state boundaries from Census Bureau\u2026';
  let states;
  try {
    states = await fetchCensusStateBoundaries();
  } catch (err) {
    console.error('Census state fetch failed:', err);
    statusEl.textContent = 'Could not fetch state boundaries from Census Bureau TIGER service.';
    return;
  }

  // Bail if user navigated to a different dataset while fetching
  if (generation !== _renderGeneration) return;

  // Step 2 — run spatial intersection counts
  statusEl.textContent = `Analyzing coverage across ${states.length} states\u2026`;
  let results;
  try {
    results = await runCoverageAnalysis(url, layerId, states, (done, total) => {
      if (generation !== _renderGeneration) return;
      statusEl.textContent = `Analyzing coverage: ${done} / ${total} states\u2026`;
    });
  } catch (err) {
    console.error('Coverage analysis failed:', err);
    statusEl.textContent = 'Coverage analysis failed \u2014 the service may not support spatial queries.';
    return;
  }

  // Bail if user navigated away during analysis
  if (generation !== _renderGeneration) return;

  _coverageAnalysisCache.set(cacheKey, results);
  paintCoverageResult(statusEl, contentEl, results);
}

function paintCoverageResult(statusEl, contentEl, results) {
  const { svg, statesWithData, totalFeatures, totalStates, failedCount } =
    buildCoverageMapSVG(results);

  let summary = `${statesWithData} of ${totalStates} states with data \u00b7 ${totalFeatures.toLocaleString()} total features`;
  if (failedCount > 0) summary += ` \u00b7 ${failedCount} state(s) could not be queried`;
  statusEl.textContent = summary;
  contentEl.innerHTML = svg;
}


// ====== CONFIG ======
const CATALOG_URL = 'data/catalog.json';
// Repo layout: /index.html, /app.js, /styles.css, /data/catalog.json

// >>>>> SET THIS to your GitHub repo's "new issue" URL base
// Example: 'https://github.com/blm-gis/public-lands-data-catalog/issues/new'
const GITHUB_NEW_ISSUE_BASE =
  'https://github.com/AmateurProjects/Public-Lands-Data-Catalog/issues/new';

// ====== CATALOG MODULE (shared loader + indexes) ======
const Catalog = (function () {
  let cache = null;
  let indexesBuilt = false;
  let attributeById = {};
  let datasetById = {};
  let datasetsByAttributeId = {};

  async function loadCatalog() {
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

  function getAttributeById(id) {
    return attributeById[id] || null;
  }

  function getDatasetById(id) {
    return datasetById[id] || null;
  }

  function getAttributesForDataset(dataset) {
    if (!dataset || !dataset.attribute_ids) return [];
    return dataset.attribute_ids.map((id) => attributeById[id]).filter(Boolean);
  }

  function getDatasetsForAttribute(attrId) {
    return datasetsByAttributeId[attrId] || [];
  }

  function buildGithubIssueUrlForDataset(dataset) {
    const title = encodeURIComponent(`Dataset change request: ${dataset.id}`);
    const bodyLines = [
      `Please describe the requested change for dataset \`${dataset.id}\` (\`${dataset.title || ''}\`).`,
      '',
      '---',
      '',
      'Current dataset JSON:',
      '```json',
      JSON.stringify(dataset, null, 2),
      '```',
    ];
    const body = encodeURIComponent(bodyLines.join('\n'));
    return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
  }

  function buildGithubIssueUrlForAttribute(attribute) {
    const title = encodeURIComponent(`Attribute change request: ${attribute.id}`);
    const bodyLines = [
      `Please describe the requested change for attribute \`${attribute.id}\` (\`${attribute.label || ''}\`).`,
      '',
      '---',
      '',
      'Current attribute JSON:',
      '```json',
      JSON.stringify(attribute, null, 2),
      '```',
    ];
    const body = encodeURIComponent(bodyLines.join('\n'));
    return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
  }

  return {
    loadCatalog,
    getAttributeById,
    getDatasetById,
    getAttributesForDataset,
    getDatasetsForAttribute,
    buildGithubIssueUrlForDataset,
    buildGithubIssueUrlForAttribute,
  };
})();

// ====== MAIN APP (tabs, lists, detail panels) ======
document.addEventListener('DOMContentLoaded', async () => {
  // --- Elements ---
  const datasetsTabBtn = document.getElementById('datasetsTab');
  const attributesTabBtn = document.getElementById('attributesTab');
  const datasetsView = document.getElementById('datasetsView');
  const attributesView = document.getElementById('attributesView');

  const datasetSearchInput = document.getElementById('datasetSearchInput');
  const attributeSearchInput = document.getElementById('attributeSearchInput');

  const datasetListEl = document.getElementById('datasetList');
  const attributeListEl = document.getElementById('attributeList');

  const datasetDetailEl = document.getElementById('datasetDetail');
  const attributeDetailEl = document.getElementById('attributeDetail');

  // Track last viewed dataset so "Cancel" (and similar actions) can return you to where you were.
  let lastSelectedDatasetId = null;


  // NOTE: goBackToAttributesListOrFirst() is defined later in Helpers.


  // --- Edit Fields for Suggest Dataset Change functionality ---
  // NOTE: DATASET_EDIT_FIELDS drives BOTH "Suggest change" and "Submit new dataset" pages

  const DATASET_EDIT_FIELDS = [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'description', label: 'Description', type: 'textarea' },

    { key: 'objname', label: 'Database Object Name', type: 'text' },
    { key: 'topics', label: 'Topics (comma-separated)', type: 'csv' },

    { key: 'agency_owner', label: 'Agency Owner', type: 'text' },
    { key: 'office_owner', label: 'Office Owner', type: 'text' },
    { key: 'contact_email', label: 'Contact Email', type: 'text' },

    { key: 'geometry_type', label: 'Geometry Type', type: 'text' },
    { key: 'update_frequency', label: 'Update Frequency', type: 'text' },

    { key: 'status', label: 'Status', type: 'text' },
    { key: 'access_level', label: 'Access Level', type: 'text' },

    { key: 'public_web_service', label: 'Public Web Service', type: 'text' },
    { key: 'internal_web_service', label: 'Internal Web Service', type: 'text' },
    { key: 'data_standard', label: 'Data Standard', type: 'text' },

    { key: 'notes', label: 'Notes', type: 'textarea' },
    
    // Development & Status
    { key: 'development_stage', label: 'Development Stage', type: 'select', options: ['planned', 'in_development', 'qa', 'production', 'deprecated'] },
    { key: 'target_release_date', label: 'Target Release Date', type: 'text' },
    { key: 'blockers', label: 'Blockers (comma-separated)', type: 'csv' },
    
    // National Scale Suitability
    { key: 'scale_suitability', label: 'Scale Suitability', type: 'select', options: ['national', 'regional', 'local'] },
    { key: 'coverage', label: 'Coverage', type: 'select', options: ['nationwide', 'multi_state', 'single_state', 'partial'] },
    { key: 'web_mercator_compatible', label: 'Web Mercator Compatible', type: 'boolean' },
    { key: 'performance_notes', label: 'Performance Notes', type: 'textarea' },
    
    // Maturity
    { key: 'maturity.completeness', label: 'Completeness (%)', type: 'number' },
    { key: 'maturity.documentation', label: 'Documentation Level', type: 'select', options: ['none', 'minimal', 'partial', 'complete'] },
    { key: 'maturity.quality_tier', label: 'Quality Tier', type: 'select', options: ['bronze', 'silver', 'gold'] },
  ];

  // --- Edit Fields for Suggest Attribute Change functionality ---
  const ATTRIBUTE_EDIT_FIELDS = [
    { key: 'label', label: 'Attribute Label', type: 'text' },
    { key: 'type', label: 'Attribute Type', type: 'text' }, // you can later make this a select
    { key: 'definition', label: 'Attribute Definition', type: 'textarea' },
    { key: 'expected_value', label: 'Example Expected Value', type: 'text' },
    { key: 'values', label: 'Allowed values (JSON array) — for enumerated types', type: 'json' },
  ];


  // --- Helpers (shared) ---
  function compactObject(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (v === undefined || v === null) return;
      if (Array.isArray(v) && v.length === 0) return;
      if (typeof v === 'string' && v.trim() === '') return;
      out[k] = v;
    });
    return out;
  }

  function parseCsvList(str) {
    return String(str || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function tryParseJson(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      return { __parse_error__: e.message };
    }
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function goBackToLastDatasetOrList() {
    showDatasetsView();
    if (lastSelectedDatasetId && Catalog.getDatasetById(lastSelectedDatasetId)) {
      renderDatasetDetail(lastSelectedDatasetId);
      return;
    }
    if (allDatasets && allDatasets.length) {
      renderDatasetDetail(allDatasets[0].id);
      return;
    }
    datasetDetailEl && datasetDetailEl.classList.add('hidden');
  }

  function goBackToAttributesListOrFirst() {
    showAttributesView();
    if (allAttributes && allAttributes.length) {
      renderAttributeDetail(allAttributes[0].id);
      return;
    }
    attributeDetailEl && attributeDetailEl.classList.add('hidden');
  }

  function computeChanges(original, updated) {
    const keys = new Set([...Object.keys(original || {}), ...Object.keys(updated || {})]);
    const changes = [];
    keys.forEach((k) => {
      const a = original ? original[k] : undefined;
      const b = updated ? updated[k] : undefined;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ key: k, from: a, to: b });
      }
    });
    return changes;
  }

  function buildGithubIssueUrlForEditedDataset(datasetId, original, updated, changes) {
    const title = encodeURIComponent(`Dataset change request: ${datasetId}`);

    const bodyLines = [
      `## Suggested changes for dataset: \`${datasetId}\``,
      '',
      '### Summary of changes',
    ];

    if (!changes.length) {
      bodyLines.push('- No changes detected.');
    } else {
      changes.forEach((c) => {
        bodyLines.push(
          `- **${c.key}**: \`${JSON.stringify(c.from)}\` → \`${JSON.stringify(c.to)}\``
        );
      });
    }

    bodyLines.push(
      '',
      '---',
      '',
      '### Original dataset JSON',
      '```json',
      JSON.stringify(original, null, 2),
      '```',
      '',
      '### Updated dataset JSON',
      '```json',
      JSON.stringify(updated, null, 2),
      '```'
    );

    const body = encodeURIComponent(bodyLines.join('\n'));
    return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
  }

  function buildGithubIssueUrlForNewDataset(datasetObj, newAttributes = []) {
    const titleBase = datasetObj.id || datasetObj.title || 'New dataset request';
    const title = encodeURIComponent(`New dataset request: ${titleBase}`);

    const bodyLines = [
      '## New dataset submission',
      '',
      'Please review the dataset proposal below. If approved, add it to `data/catalog.json` under `datasets`.',
      '',
      '### Review checklist',
      '- [ ] ID is unique and follows naming conventions',
      '- [ ] Title/description are clear',
      '- [ ] Owner/contact info is present',
      '- [ ] Geometry type is correct',
      '- [ ] Attribute IDs are valid (existing or proposed below)',
      '- [ ] Services/standards links are valid (if provided)',
      '',
      '---',
      '',
      '### Proposed dataset JSON',
      '```json',
      JSON.stringify(datasetObj, null, 2),
      '```',
    ];

  if (Array.isArray(newAttributes) && newAttributes.length) {
    bodyLines.push(
      '',
      '---',
      '',
      '### Proposed NEW attributes JSON (add under `attributes`)',
      '```json',
      JSON.stringify(newAttributes, null, 2),
      '```'
    );
  }

    const body = encodeURIComponent(bodyLines.join('\n'));
    return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
  }

  function buildGithubIssueUrlForEditedAttribute(attrId, original, updated, changes) {
    const title = encodeURIComponent(`Attribute change request: ${attrId}`);

    const bodyLines = [
      `## Suggested changes for attribute: \`${attrId}\``,
      '',
      '### Summary of changes',
    ];

    if (!changes.length) {
      bodyLines.push('- No changes detected.');
    } else {
      changes.forEach((c) => {
        bodyLines.push(
          `- **${c.key}**: \`${JSON.stringify(c.from)}\` → \`${JSON.stringify(c.to)}\``
        );
      });
    }

    bodyLines.push(
      '',
      '---',
      '',
      '### Original attribute JSON',
      '```json',
      JSON.stringify(original, null, 2),
      '```',
      '',
      '### Updated attribute JSON',
      '```json',
      JSON.stringify(updated, null, 2),
      '```'
    );

    const body = encodeURIComponent(bodyLines.join('\n'));
    return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
  }

  function buildGithubIssueUrlForNewAttributes(payload) {
    const title = encodeURIComponent(payload.title || 'New attribute(s) request');

    const bodyLines = [
      '## New attribute(s) submission',
      '',
      'Please review the attribute proposal below. If approved, add it to `data/catalog.json` under `attributes`.',
      '',
      '### Review checklist',
      '- [ ] ID(s) are unique and follow naming conventions',
      '- [ ] Type/definition are clear',
      '- [ ] Enumerations are complete (if applicable)',
      '',
      '---',
      '',
      '### Proposed attributes JSON',
      '```json',
      JSON.stringify(payload.attributes, null, 2),
      '```',
    ];

    if (payload.notes) {
      bodyLines.push('', '### Notes / context', payload.notes);
    }

    const body = encodeURIComponent(bodyLines.join('\n'));
    return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
  }



  // --- Edit mode renderer ---

  function renderDatasetEditForm(datasetId) {
    if (!datasetDetailEl) return;

    const dataset = Catalog.getDatasetById(datasetId);
    if (!dataset) return;

    const original = deepClone(dataset);
    const draft = deepClone(dataset);
    const attrs = Catalog.getAttributesForDataset(dataset);

    let html = '';

    // Breadcrumb
    html += `
    <nav class="breadcrumb">
      <button type="button" class="breadcrumb-root" data-breadcrumb="datasets">Datasets</button>
      <span class="breadcrumb-separator">/</span>
      <span class="breadcrumb-current">${escapeHtml(dataset.title || dataset.id)}</span>
    </nav>
  `;

    html += `<h2>Editing: ${escapeHtml(dataset.title || dataset.id)}</h2>`;
    if (dataset.description) html += `<p>${escapeHtml(dataset.description)}</p>`;

    // Helper to get nested value from draft
    function getNestedValue(obj, path) {
      return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
    }

    // Form container
    html += `<div class="card card-meta" id="datasetEditCard">`;
    html += `<div class="dataset-edit-actions">
      <button type="button" class="btn" data-edit-cancel>Cancel</button>
      <button type="button" class="btn primary" data-edit-submit>Submit suggestion</button>
    </div>`;

    // Fields
    DATASET_EDIT_FIELDS.forEach((f) => {
      const val = getNestedValue(draft, f.key);

      if (f.type === 'textarea') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <textarea class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">${escapeHtml(
          val || ''
        )}</textarea>
        </div>
      `;
      } else if (f.type === 'select' && Array.isArray(f.options)) {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <select class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">
            <option value="">(select)</option>
            ${f.options.map(opt => `<option value="${escapeHtml(opt)}" ${val === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
          </select>
        </div>
      `;
      } else if (f.type === 'boolean') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <select class="dataset-edit-input" data-edit-key="${escapeHtml(f.key)}">
            <option value="">(select)</option>
            <option value="true" ${val === true ? 'selected' : ''}>Yes</option>
            <option value="false" ${val === false ? 'selected' : ''}>No</option>
          </select>
        </div>
      `;
      } else if (f.type === 'number') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <input class="dataset-edit-input" type="number" data-edit-key="${escapeHtml(f.key)}" value="${val !== undefined ? escapeHtml(String(val)) : ''}" />
        </div>
      `;
      } else {
        const displayVal =
          f.type === 'csv' && Array.isArray(val) ? val.join(', ') : (val || '');
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <input class="dataset-edit-input" type="text" data-edit-key="${escapeHtml(
          f.key
        )}" value="${escapeHtml(displayVal)}" />
        </div>
      `;
      }
    });

    html += `</div>`;

    // Keep attributes section unchanged (read-only), as requested
    html += `
    <div class="card-row">
      <div class="card card-attributes">
        <h3>Attributes</h3>
  `;

    if (!attrs.length) {
      html += '<p>No attributes defined for this dataset.</p>';
    } else {
      html += '<ul>';
      attrs.forEach((attr) => {
        html += `
        <li>
          <button type="button" class="link-button" data-attr-id="${escapeHtml(attr.id)}">
            ${escapeHtml(attr.id)} – ${escapeHtml(attr.label || '')}
          </button>
        </li>`;
      });
      html += '</ul>';
    }

    html += `
      </div>
      <div class="card card-inline-attribute" id="inlineAttributeDetail">
        <h3>Attribute details</h3>
        <p>Select an attribute from the list to see its properties here without leaving this dataset.</p>
      </div>
    </div>
  `;

    datasetDetailEl.innerHTML = html;
    datasetDetailEl.classList.remove('hidden');

    // Bounce + stagger cards (same feel as detail pages)
    staggerCards(datasetDetailEl);
    animatePanel(datasetDetailEl);

    // Breadcrumb
    const rootBtn = datasetDetailEl.querySelector('button[data-breadcrumb="datasets"]');
    if (rootBtn) rootBtn.addEventListener('click', showDatasetsView);

    // Inline attribute hooks
    const attrButtons = datasetDetailEl.querySelectorAll('button[data-attr-id]');
    attrButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const attrId = btn.getAttribute('data-attr-id');
        renderInlineAttributeDetail(attrId);
      });
    });

    // Cancel -> back to normal view
    const cancelBtn = datasetDetailEl.querySelector('button[data-edit-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => renderDatasetDetail(datasetId));

    // Submit -> collect values, compute diff, open issue
    const submitBtn = datasetDetailEl.querySelector('button[data-edit-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // Helper to set nested value in draft
        function setNestedValue(obj, path, value) {
          const keys = path.split('.');
          let current = obj;
          for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]]) current[keys[i]] = {};
            current = current[keys[i]];
          }
          current[keys[keys.length - 1]] = value;
        }

        const inputs = datasetDetailEl.querySelectorAll('[data-edit-key]');
        inputs.forEach((el) => {
          const k = el.getAttribute('data-edit-key');
          const raw = el.value;

          const fieldDef = DATASET_EDIT_FIELDS.find((x) => x.key === k);
          let parsedValue;

          if (fieldDef && fieldDef.type === 'csv') {
            parsedValue = parseCsvList(raw);
          } else if (fieldDef && fieldDef.type === 'boolean') {
            if (raw === 'true') parsedValue = true;
            else if (raw === 'false') parsedValue = false;
            else parsedValue = undefined;
          } else if (fieldDef && fieldDef.type === 'number') {
            const num = parseFloat(raw);
            parsedValue = isNaN(num) ? undefined : num;
          } else {
            parsedValue = String(raw || '').trim() || undefined;
          }

          // Handle nested keys like maturity.completeness
          if (k.includes('.')) {
            setNestedValue(draft, k, parsedValue);
          } else {
            draft[k] = parsedValue;
          }
        });

        const updated = compactObject(draft);
        const origCompact = compactObject(original);
        const changes = computeChanges(origCompact, updated);

        const issueUrl = buildGithubIssueUrlForEditedDataset(datasetId, origCompact, updated, changes);

        // Return UI to normal view right away
        renderDatasetDetail(datasetId);

        // Then open the GitHub issue in a new tab
        window.open(issueUrl, '_blank', 'noopener');

      });
    }
  }

  // --- NEW ATTRIBUTE "editable page" (replaces the modal) ---
  function renderNewAttributeCreateForm(prefill = {}) {
    // Use attribute detail panel when we are on the Attributes tab;
    // otherwise fall back to dataset detail panel (rare).
    const hostEl = attributeDetailEl || datasetDetailEl;
    if (!hostEl) return;

    const NEW_ATTR_PLACEHOLDERS =
      (catalogData &&
        catalogData.ui &&
        catalogData.ui.placeholders &&
        catalogData.ui.placeholders.new_attribute) ||
      {};

    function placeholderFor(key, fallback = '') {
      return escapeHtml(NEW_ATTR_PLACEHOLDERS[key] || fallback || '');
    }

    // draft supports both single + bulk modes
    const draft = {
      mode: 'single', // 'single' | 'bulk'
      id: '',
      label: '',
      type: '',
      definition: '',
      expected_value: '',
      values_json: '',
      notes: '',
      bulk_json: '',
      bulk_notes: '',
      ...deepClone(prefill || {}),
    };

    let html = '';

    // Breadcrumb (Attributes)
    html += `
      <nav class="breadcrumb">
        <button type="button" class="breadcrumb-root" data-breadcrumb="attributes">Attributes</button>
        <span class="breadcrumb-separator">/</span>
        <span class="breadcrumb-current">Add new attribute</span>
      </nav>
    `;

    html += `<h2>Add a new attribute</h2>`;
    html += `<p class="modal-help">This will open a pre-filled GitHub Issue for review/approval by the catalog owner.</p>`;

    // Mode toggle
    html += `
      <div class="card card-meta">
        <div class="dataset-edit-actions">
          <button type="button" class="btn ${draft.mode === 'single' ? 'primary' : ''}" data-new-attr-mode="single">Single</button>
          <button type="button" class="btn ${draft.mode === 'bulk' ? 'primary' : ''}" data-new-attr-mode="bulk">Bulk JSON</button>
          <span style="flex:1"></span>
          <button type="button" class="btn" data-new-attr-cancel>Cancel</button>
          <button type="button" class="btn primary" data-new-attr-submit>Submit suggestion</button>
        </div>
      </div>
    `;

    // Single form card
    html += `<div class="card card-attribute-meta" id="newAttrSingleCard" ${draft.mode === 'bulk' ? 'style="display:none"' : ''}>`;

    // Attribute ID first (required)
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Attribute ID (required)</label>
        <input class="dataset-edit-input" type="text" data-new-attr-key="id"
               placeholder="${placeholderFor('id', 'e.g., STATE_NAME')}"
               value="${escapeHtml(draft.id || '')}" />
      </div>
    `;

    // Use your existing field list so the “feel” matches edit mode
    ATTRIBUTE_EDIT_FIELDS.forEach((f) => {
      // note: your attribute object uses expected_value but the edit fields key is expected_value already
      const k = f.key;
      let val = '';
      if (k === 'values') val = draft.values_json || '';
      else val = draft[k] === undefined ? '' : String(draft[k] || '');

      if (f.type === 'textarea' || f.type === 'json') {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <textarea class="dataset-edit-input" data-new-attr-key="${escapeHtml(k)}"
              placeholder="${placeholderFor(k)}">${escapeHtml(val)}</textarea>
          </div>
        `;
      } else {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <input class="dataset-edit-input" type="text" data-new-attr-key="${escapeHtml(k)}"
              placeholder="${placeholderFor(k)}"
              value="${escapeHtml(val)}" />
          </div>
        `;
      }
    });

    // Notes
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Notes / context (optional)</label>
        <textarea class="dataset-edit-input" data-new-attr-key="notes"
          placeholder="${placeholderFor('notes', 'any extra context for reviewers')}">${escapeHtml(draft.notes || '')}</textarea>
      </div>
    `;

    html += `</div>`;

    // Bulk form card
    html += `<div class="card card-attribute-meta" id="newAttrBulkCard" ${draft.mode === 'single' ? 'style="display:none"' : ''}>`;
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Bulk attributes JSON (required)</label>
        <textarea class="dataset-edit-input" data-new-attr-bulk="json" rows="12"
          placeholder="${placeholderFor('bulk_attributes_json', '[{ \"id\": \"...\", \"label\": \"...\" }]')}">${escapeHtml(draft.bulk_json || '')}</textarea>
      </div>
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Notes / context (optional)</label>
        <textarea class="dataset-edit-input" data-new-attr-bulk="notes"
          placeholder="${placeholderFor('bulk_notes', 'any extra context for reviewers')}">${escapeHtml(draft.bulk_notes || '')}</textarea>
      </div>
    `;
    html += `</div>`;

    hostEl.innerHTML = html;
    hostEl.classList.remove('hidden');

    // Bounce + stagger cards (same feel as detail pages)
    staggerCards(hostEl);
    animatePanel(hostEl);

    // Breadcrumb root
    const rootBtn = hostEl.querySelector('button[data-breadcrumb="attributes"]');
    if (rootBtn) rootBtn.addEventListener('click', showAttributesView);

    // Cancel -> back to list/first attribute
    const cancelBtn = hostEl.querySelector('button[data-new-attr-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', goBackToAttributesListOrFirst);

    // Mode switching
    const modeBtns = hostEl.querySelectorAll('button[data-new-attr-mode]');
    const singleCard = hostEl.querySelector('#newAttrSingleCard');
    const bulkCard = hostEl.querySelector('#newAttrBulkCard');
    modeBtns.forEach((b) => {
      b.addEventListener('click', () => {
        const mode = b.getAttribute('data-new-attr-mode');
        const isBulk = mode === 'bulk';
        if (singleCard) singleCard.style.display = isBulk ? 'none' : '';
        if (bulkCard) bulkCard.style.display = isBulk ? '' : 'none';
        modeBtns.forEach((x) => {
          const active = x.getAttribute('data-new-attr-mode') === mode;
          x.classList.toggle('primary', active);
        });
      });
    });

    // Submit -> validate, build payload, open issue, then return UI to normal view
    const submitBtn = hostEl.querySelector('button[data-new-attr-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // determine mode from which card is visible
        const isBulk = bulkCard && bulkCard.style.display !== 'none';

        let attributesPayload = [];
        let notes = '';

        if (isBulk) {
          const raw = String(hostEl.querySelector('[data-new-attr-bulk="json"]')?.value || '').trim();
          notes = String(hostEl.querySelector('[data-new-attr-bulk="notes"]')?.value || '').trim();

          const parsed = tryParseJson(raw);
          if (!parsed) {
            alert('Bulk JSON is required.');
            return;
          }
          if (parsed.__parse_error__) {
            alert(`Bulk JSON parse error:\n${parsed.__parse_error__}`);
            return;
          }
          if (!Array.isArray(parsed)) {
            alert('Bulk JSON must be a JSON array of attribute objects.');
            return;
          }
          attributesPayload = parsed;
        } else {
          const getVal = (k) => String(hostEl.querySelector(`[data-new-attr-key="${k}"]`)?.value || '').trim();

          const id = getVal('id');
          if (!id) {
            alert('Attribute ID is required.');
            return;
          }

          const type = getVal('type');
          const definition = getVal('definition');
          const label = getVal('label');
          const expectedValueRaw = getVal('expected_value');
          notes = getVal('notes');

          let values = undefined;
          if (type === 'enumerated') {
            const valuesRaw = getVal('values');
            if (valuesRaw) {
              const parsedValues = tryParseJson(valuesRaw);
              if (parsedValues && parsedValues.__parse_error__) {
                alert(`Enumerated values JSON parse error:\n${parsedValues.__parse_error__}`);
                return;
              }
              if (parsedValues && !Array.isArray(parsedValues)) {
                alert('Enumerated values must be a JSON array of objects like {code,label,description}.');
                return;
              }
              values = parsedValues || [];
            } else {
              values = [];
            }
          }

          const attrObj = compactObject({
            id,
            label,
            type,
            definition,
            expected_value: expectedValueRaw || undefined,
            values,
          });

          const exists = Catalog.getAttributeById(id);
          if (exists) {
            const proceed = confirm(`An attribute with ID "${id}" already exists. Open an issue anyway?`);
            if (!proceed) return;
          }

          attributesPayload = [attrObj];
        }

        const missingIds = attributesPayload.filter((a) => !a || typeof a !== 'object' || !a.id).length;
        if (missingIds) {
          alert('One or more attribute objects are missing an "id" field.');
          return;
        }

        const payload = {
          title:
            attributesPayload.length === 1
              ? `New attribute request: ${attributesPayload[0].id}`
              : `New attributes request (${attributesPayload.length})`,
          attributes: attributesPayload,
          notes,
        };

        const issueUrl = buildGithubIssueUrlForNewAttributes(payload);

        // Return UI to normal attribute view immediately
        goBackToAttributesListOrFirst();

        const w = window.open(issueUrl, '_blank', 'noopener');
        if (!w) alert('Popup blocked — please allow popups to open the GitHub Issue.');
      });
    }
  }

    // --- NEW DATASET "editable page" (replaces the modal) ---
   function renderNewDatasetCreateForm(prefill = {}) {
    if (!datasetDetailEl) return;

    // Placeholder strings come from data/catalog.json so you can edit without touching JS
    const NEW_DATASET_PLACEHOLDERS =
      (catalogData &&
        catalogData.ui &&
        catalogData.ui.placeholders &&
        catalogData.ui.placeholders.new_dataset) ||
      {};

    function placeholderFor(key, fallback = '') {
      return escapeHtml(NEW_DATASET_PLACEHOLDERS[key] || fallback || '');
    }

// NOTE: goBackToLastDatasetOrList() is defined in Helpers above.


    // Start with a blank draft; allow optional prefill (future use)
    const draft = {
      id: '',
      title: '',
      description: '',
      objname: '',
      topics: [],
      agency_owner: '',
      office_owner: '',
      contact_email: '',
      geometry_type: '',
      update_frequency: '',
      status: '',
      access_level: '',
      public_web_service: '',
      internal_web_service: '',
      data_standard: '',
      projection: '',
      notes: '',
      // NEW: attribute selection/creation
      attribute_ids: [],       // existing attribute IDs selected
      new_attributes: [],      // array of new attribute draft objects

      ...deepClone(prefill || {}),
    };

    let html = '';

    // Breadcrumb
    html += `
      <nav class="breadcrumb">
        <button type="button" class="breadcrumb-root" data-breadcrumb="datasets">Datasets</button>
        <span class="breadcrumb-separator">/</span>
        <span class="breadcrumb-current">Submit new dataset</span>
      </nav>
    `;

    html += `<h2>Submit a new dataset</h2>`;
    html += `<p class="modal-help">This will open a pre-filled GitHub Issue for review/approval by the catalog owner.</p>`;

    html += `<div class="card card-meta" id="newDatasetEditCard">`;
    html += `
      <div class="dataset-edit-actions">
        <button type="button" class="btn" data-new-ds-cancel>Cancel</button>
        <button type="button" class="btn primary" data-new-ds-submit>Submit suggestion</button>
      </div>
    `;

    // Dataset ID (required) — shown first
    html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Dataset ID (required)</label>
        <input class="dataset-edit-input" type="text" data-new-ds-key="id"
               placeholder="${placeholderFor('id', 'e.g., blm_rmp_boundaries')}"
               value="${escapeHtml(draft.id || '')}" />
      </div>
    `;

    // Render the rest using the same field list you use for edit mode
    DATASET_EDIT_FIELDS.forEach((f) => {
      const val = draft[f.key];

      if (f.type === 'textarea') {
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <textarea class="dataset-edit-input" data-new-ds-key="${escapeHtml(f.key)}"
                      placeholder="${placeholderFor(f.key)}">${escapeHtml(val || '')}</textarea>
          </div>
        `;
      } else {
        const displayVal =
          f.type === 'csv' && Array.isArray(val) ? val.join(', ') : (val || '');
        html += `
          <div class="dataset-edit-row">
            <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
            <input class="dataset-edit-input" type="text" data-new-ds-key="${escapeHtml(f.key)}"
                   placeholder="${placeholderFor(f.key)}"
                   value="${escapeHtml(displayVal)}" />
         </div>
        `;
      }
    });

    html += `</div>`;

  // ---------------------------
  // Attributes section (existing + new)
  // ---------------------------

  // Datalist options for existing attributes
  const attrOptions = (allAttributes || [])
    .map((a) => {
      const id = a.id || '';
      const label = a.label ? ` — ${a.label}` : '';
      return `<option value="${escapeHtml(id)}">${escapeHtml(id + label)}</option>`;
    })
    .join('');

  html += `
    <div class="card card-meta" id="newDatasetAttributesCard">
      <h3>Attributes</h3>
      <p class="modal-help" style="margin-top:0.25rem;">
        Add existing attributes, or create new ones inline. New attributes will be included in the GitHub issue.
      </p>

      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Add existing attribute (search by ID)</label>
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <input class="dataset-edit-input" style="flex:1;" type="text"
            list="existingAttributesDatalist"
            data-new-ds-existing-attr-input
            placeholder="Start typing an attribute ID..." />
          <button type="button" class="btn" data-new-ds-add-existing-attr>Add</button>
        </div>
        <datalist id="existingAttributesDatalist">
          ${attrOptions}
        </datalist>
      </div>

      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Selected attributes</label>
        <div data-new-ds-selected-attrs style="display:flex; flex-wrap:wrap; gap:0.5rem;"></div>
      </div>

      <div class="dataset-edit-row">
        <label class="dataset-edit-label">Create new attribute</label>
        <div>
          <button type="button" class="btn" data-new-ds-add-new-attr>+ Add new attribute</button>
        </div>
      </div>

      <div data-new-ds-new-attrs></div>
    </div>
  `;


    datasetDetailEl.innerHTML = html;
    datasetDetailEl.classList.remove('hidden');

  // ---------- Attributes UI wiring ----------

  const selectedAttrsEl = datasetDetailEl.querySelector('[data-new-ds-selected-attrs]');
  const existingAttrInput = datasetDetailEl.querySelector('[data-new-ds-existing-attr-input]');
  const addExistingBtn = datasetDetailEl.querySelector('button[data-new-ds-add-existing-attr]');
  const addNewAttrBtn = datasetDetailEl.querySelector('button[data-new-ds-add-new-attr]');
  const newAttrsHost = datasetDetailEl.querySelector('[data-new-ds-new-attrs]');

  const NEW_ATTR_PLACEHOLDERS =
    (catalogData &&
      catalogData.ui &&
      catalogData.ui.placeholders &&
      catalogData.ui.placeholders.new_attribute) ||
    {};
  function attrPlaceholderFor(key, fallback = '') {
    return escapeHtml(NEW_ATTR_PLACEHOLDERS[key] || fallback || '');
  }

  function renderSelectedAttrChips() {
    if (!selectedAttrsEl) return;
    const ids = Array.from(new Set((draft.attribute_ids || []).map((x) => String(x || '').trim()).filter(Boolean)));
    draft.attribute_ids = ids;

    selectedAttrsEl.innerHTML = ids.length
      ? ids
          .map(
            (id) => `
              <span class="pill pill-keyword" style="display:inline-flex; gap:0.4rem; align-items:center;">
                <span>${escapeHtml(id)}</span>
                <button type="button" class="icon-button" style="padding:0.15rem 0.35rem;" data-remove-attr-id="${escapeHtml(id)}">✕</button>
              </span>
            `
          )
          .join('')
      : `<span style="color: var(--text-muted);">None selected yet.</span>`;

    // remove handlers
    selectedAttrsEl.querySelectorAll('button[data-remove-attr-id]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-remove-attr-id');
        draft.attribute_ids = (draft.attribute_ids || []).filter((x) => x !== id);
        renderSelectedAttrChips();
      });
    });
  }

  function makeNewAttrDraft() {
    return {
      id: '',
      label: '',
      type: '',
      definition: '',
      expected_value: '',
      values_json: '',
      notes: '',
    };
  }

  function renderNewAttributesForms() {
    if (!newAttrsHost) return;
    const arr = draft.new_attributes || [];
    if (!arr.length) {
      newAttrsHost.innerHTML = '';
      return;
    }

    newAttrsHost.innerHTML = arr
      .map((a, idx) => {
        const safeIdx = String(idx);
        return `
          <div class="card" style="margin-top:0.75rem;" data-new-attr-card data-new-attr-idx="${safeIdx}">
            <div class="dataset-edit-actions" style="margin-bottom:0.75rem;">
              <strong style="align-self:center;">New attribute #${idx + 1}</strong>
              <span style="flex:1"></span>
              <button type="button" class="btn" data-remove-new-attr="${safeIdx}">Remove</button>
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute ID (required)</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="id"
                placeholder="${attrPlaceholderFor('id', 'e.g., STATE_NAME')}"
                value="${escapeHtml(a.id || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute Label</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="label"
                placeholder="${attrPlaceholderFor('label', 'Human-friendly label')}"
                value="${escapeHtml(a.label || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute Type</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="type"
                placeholder="${attrPlaceholderFor('type', 'string / integer / enumerated / ...')}"
                value="${escapeHtml(a.type || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Attribute Definition</label>
              <textarea class="dataset-edit-input"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="definition"
                placeholder="${attrPlaceholderFor('definition', 'What this attribute means and how it is used')}">${escapeHtml(a.definition || '')}</textarea>
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Example Expected Value</label>
              <input class="dataset-edit-input" type="text"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="expected_value"
                placeholder="${attrPlaceholderFor('expected_value', 'Optional example')}"
                value="${escapeHtml(a.expected_value || '')}" />
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Allowed values (JSON array) — only if type = enumerated</label>
              <textarea class="dataset-edit-input"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="values_json"
                placeholder='${attrPlaceholderFor(
                  'values',
                  '[{"code":1,"label":"Yes","description":"..."},{"code":0,"label":"No"}]'
                )}'>${escapeHtml(a.values_json || '')}</textarea>
            </div>

            <div class="dataset-edit-row">
              <label class="dataset-edit-label">Notes / context (optional)</label>
              <textarea class="dataset-edit-input"
                data-new-attr-idx="${safeIdx}" data-new-attr-key="notes"
                placeholder="${attrPlaceholderFor('notes', 'Any context for reviewers')}">${escapeHtml(a.notes || '')}</textarea>
            </div>
          </div>
        `;
      })
      .join('');

    // Remove new attribute handlers
    newAttrsHost.querySelectorAll('button[data-remove-new-attr]').forEach((b) => {
      b.addEventListener('click', () => {
        const idx = Number(b.getAttribute('data-remove-new-attr'));
        if (Number.isNaN(idx)) return;
        draft.new_attributes.splice(idx, 1);
        renderNewAttributesForms();
      });
    });
  }

  if (addExistingBtn) {
    addExistingBtn.addEventListener('click', () => {
      const raw = String(existingAttrInput?.value || '').trim();
      if (!raw) return;
      const exists = Catalog.getAttributeById(raw);
      if (!exists) {
        alert(`Attribute "${raw}" doesn't exist yet. Use "Add new attribute" to propose it.`);
        return;
      }
      draft.attribute_ids = draft.attribute_ids || [];
      if (!draft.attribute_ids.includes(raw)) draft.attribute_ids.push(raw);
      if (existingAttrInput) existingAttrInput.value = '';
      renderSelectedAttrChips();
    });
  }

  if (addNewAttrBtn) {
    addNewAttrBtn.addEventListener('click', () => {
      draft.new_attributes = draft.new_attributes || [];
      draft.new_attributes.push(makeNewAttrDraft());
      renderNewAttributesForms();
    });
  }

  // Initial paints
  renderSelectedAttrChips();
  renderNewAttributesForms();

    // Bounce + stagger cards (same feel as detail pages)
    staggerCards(datasetDetailEl);
    animatePanel(datasetDetailEl);

    // Breadcrumb root
    const rootBtn = datasetDetailEl.querySelector('button[data-breadcrumb="datasets"]');
    if (rootBtn) rootBtn.addEventListener('click', showDatasetsView);

    // Cancel: return to “normal” dataset view (first dataset) or just show list
    const cancelBtn = datasetDetailEl.querySelector('button[data-new-ds-cancel]');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
      goBackToLastDatasetOrList();
      });
    }

    // Submit: validate, build payload, open issue, then return UI to normal view
    const submitBtn = datasetDetailEl.querySelector('button[data-new-ds-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        const inputs = datasetDetailEl.querySelectorAll('[data-new-ds-key]');
        const out = {};

        inputs.forEach((el) => {
          const k = el.getAttribute('data-new-ds-key');
          const raw = el.value;

          if (k === 'topics') {
            out[k] = parseCsvList(raw);
            return;
          }
          out[k] = String(raw || '').trim();
        });

        const id = String(out.id || '').trim();
        if (!id) {
          alert('Dataset ID is required.');
          return;
        }

        // If ID already exists, confirm
        const exists = Catalog.getDatasetById(id);
        if (exists) {
          const proceed = confirm(
            `A dataset with ID "${id}" already exists in the catalog. Open an issue anyway?`
          );
          if (!proceed) return;
        }

        // Build the dataset object (remove empty values)
        // 1) Collect new attribute drafts from the UI (so typing is captured)
        const newAttrInputs = datasetDetailEl.querySelectorAll('[data-new-attr-idx][data-new-attr-key]');
        newAttrInputs.forEach((el) => {
          const idx = Number(el.getAttribute('data-new-attr-idx'));
          const k = el.getAttribute('data-new-attr-key');
          if (Number.isNaN(idx) || !k) return;
          if (!draft.new_attributes || !draft.new_attributes[idx]) return;
          draft.new_attributes[idx][k] = String(el.value || '');
        });

        // 2) Validate + build new attribute objects
        const newAttributesOut = [];
        const newAttrIds = [];
        (draft.new_attributes || []).forEach((a, i) => {
          const aid = String(a.id || '').trim();
          if (!aid) {
            alert(`New attribute #${i + 1} is missing an Attribute ID.`);
            return;
          }

          // If it already exists, force user to add it as an existing attribute instead
          if (Catalog.getAttributeById(aid)) {
            alert(`New attribute ID "${aid}" already exists. Add it as an existing attribute instead.`);
            return;
          }

          const type = String(a.type || '').trim();
          let values = undefined;
          if (type === 'enumerated') {
            const rawVals = String(a.values_json || '').trim();
            if (rawVals) {
              const parsed = tryParseJson(rawVals);
              if (parsed && parsed.__parse_error__) {
                alert(`Enumerated values JSON parse error for "${aid}":\n${parsed.__parse_error__}`);
                return;
              }
              if (parsed && !Array.isArray(parsed)) {
                alert(`Enumerated values for "${aid}" must be a JSON array.`);
                return;
              }
              values = parsed || [];
            } else {
              values = [];
            }
          }

          const attrObj = compactObject({
            id: aid,
            label: String(a.label || '').trim() || undefined,
            type: type || undefined,
            definition: String(a.definition || '').trim() || undefined,
            expected_value: String(a.expected_value || '').trim() || undefined,
            values,
          });

          newAttributesOut.push(attrObj);
          newAttrIds.push(aid);
        });

        // 3) Combine existing + new attribute IDs (de-dupe)
        const existingIds = Array.from(
          new Set((draft.attribute_ids || []).map((x) => String(x || '').trim()).filter(Boolean))
        );
        const combinedAttrIds = Array.from(new Set([...existingIds, ...newAttrIds]));

        const datasetObj = compactObject({
          id,
          title: out.title,
          description: out.description,
          objname: out.objname,
          geometry_type: out.geometry_type,
          agency_owner: out.agency_owner,
          office_owner: out.office_owner,
          contact_email: out.contact_email,
          topics: out.topics || [],
          update_frequency: out.update_frequency,
          status: out.status,
          access_level: out.access_level,
          public_web_service: out.public_web_service,
          internal_web_service: out.internal_web_service,
          data_standard: out.data_standard,
          projection: out.projection,
          notes: out.notes,
          attribute_ids: combinedAttrIds.length ? combinedAttrIds : undefined,
        });

        const issueUrl = buildGithubIssueUrlForNewDataset(datasetObj, newAttributesOut);

        // Return UI to normal dataset view immediately
        goBackToLastDatasetOrList();

        const w = window.open(issueUrl, '_blank', 'noopener');
        if (!w) alert('Popup blocked — please allow popups to open the GitHub Issue.');
      });
    }
  }


  function renderAttributeEditForm(attrId) {
    if (!attributeDetailEl) return;

    const attribute = Catalog.getAttributeById(attrId);
    if (!attribute) return;

    const original = deepClone(attribute);
    const draft = deepClone(attribute);
    const datasets = Catalog.getDatasetsForAttribute(attrId) || [];

    let html = '';

    html += `
    <nav class="breadcrumb">
      <button type="button" class="breadcrumb-root" data-breadcrumb="attributes">Attributes</button>
      <span class="breadcrumb-separator">/</span>
      <span class="breadcrumb-current">${escapeHtml(attribute.id)}</span>
    </nav>
  `;

    html += `<h2>Editing: ${escapeHtml(attribute.id)} – ${escapeHtml(attribute.label || '')}</h2>`;

    html += `<div class="card card-attribute-meta" id="attributeEditCard">`;

    html += `<div class="dataset-edit-actions">
      <button type="button" class="btn" data-edit-attr-cancel>Cancel</button>
      <button type="button" class="btn primary" data-edit-attr-submit>Submit suggestion</button>
    </div>`;

    ATTRIBUTE_EDIT_FIELDS.forEach((f) => {
      let val = draft[f.key];

      // For enumerated values, we edit as JSON text
      if (f.type === 'json') {
        val = val === undefined ? '' : JSON.stringify(val, null, 2);
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <textarea class="dataset-edit-input" data-edit-attr-key="${escapeHtml(f.key)}">${escapeHtml(
          val
        )}</textarea>
        </div>
      `;
        return;
      }

      if (f.type === 'textarea') {
        html += `
        <div class="dataset-edit-row">
          <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
          <textarea class="dataset-edit-input" data-edit-attr-key="${escapeHtml(f.key)}">${escapeHtml(
          val || ''
        )}</textarea>
        </div>
      `;
        return;
      }

      html += `
      <div class="dataset-edit-row">
        <label class="dataset-edit-label">${escapeHtml(f.label)}</label>
        <input class="dataset-edit-input" type="text" data-edit-attr-key="${escapeHtml(
        f.key
      )}" value="${escapeHtml(val === undefined ? '' : String(val))}" />
      </div>
    `;
    });

    html += `</div>`;

    // Keep “Allowed values” preview if it exists (optional but nice)
    if (attribute.type === 'enumerated' && Array.isArray(attribute.values) && attribute.values.length) {
      html += '<div class="card card-enumerated">';
      html += '<h3>Current allowed values (read-only preview)</h3>';
      html += `
      <table>
        <thead>
          <tr><th>Code</th><th>Label</th><th>Description</th></tr>
        </thead>
        <tbody>
    `;
      attribute.values.forEach((v) => {
        const code = v.code !== undefined ? String(v.code) : '';
        const label = v.label || '';
        const desc = v.description || '';
        html += `
        <tr>
          <td>${escapeHtml(code)}</td>
          <td>${escapeHtml(label)}</td>
          <td>${escapeHtml(desc)}</td>
        </tr>
      `;
      });
      html += `
        </tbody>
      </table>
    `;
      html += '</div>';
    }

    // Keep datasets list unchanged (read-only), like your normal view
    html += '<div class="card card-attribute-datasets">';
    html += '<h3>Datasets using this attribute</h3>';
    if (!datasets.length) {
      html += '<p>No datasets currently reference this attribute.</p>';
    } else {
      html += '<ul>';
      datasets.forEach((ds) => {
        html += `
        <li>
          <button type="button" class="link-button" data-dataset-id="${escapeHtml(ds.id)}">
            ${escapeHtml(ds.title || ds.id)}
          </button>
        </li>`;
      });
      html += '</ul>';
    }
    html += '</div>';

    attributeDetailEl.innerHTML = html;
    attributeDetailEl.classList.remove('hidden');

    // Animate ONLY when entering edit mode (not when browsing existing attributes)
    staggerCards(attributeDetailEl);
    animatePanel(attributeDetailEl);

    // Breadcrumb root
    const rootBtn = attributeDetailEl.querySelector('button[data-breadcrumb="attributes"]');
    if (rootBtn) rootBtn.addEventListener('click', showAttributesView);

    // Dataset navigation still works
    const dsButtons = attributeDetailEl.querySelectorAll('button[data-dataset-id]');
    dsButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const dsId = btn.getAttribute('data-dataset-id');
        showDatasetsView();
        renderDatasetDetail(dsId);
      });
    });

    // Cancel -> normal view
    const cancelBtn = attributeDetailEl.querySelector('button[data-edit-attr-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => renderAttributeDetail(attrId));

    // Submit -> collect, validate JSON for values, diff, open issue, return to normal view
    const submitBtn = attributeDetailEl.querySelector('button[data-edit-attr-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        let hadError = false;
        const inputs = attributeDetailEl.querySelectorAll('[data-edit-attr-key]');
        inputs.forEach((el) => {
          const k = el.getAttribute('data-edit-attr-key');
          const raw = el.value;

          const def = ATTRIBUTE_EDIT_FIELDS.find((x) => x.key === k);
          if (def && def.type === 'json') {
            const parsed = tryParseJson(raw);
            if (parsed && parsed.__parse_error__) {
              alert(`Allowed values JSON parse error:\n${parsed.__parse_error__}`);
              hadError = true;
              return;
            }
            draft[k] = parsed === null ? undefined : parsed;
          } else {
            const s = String(raw || '').trim();
            draft[k] = s === '' ? undefined : s;
          }
        });

        if (hadError) return;

        const updated = compactObject(draft);
        const origCompact = compactObject(original);
        const changes = computeChanges(origCompact, updated);

        const issueUrl = buildGithubIssueUrlForEditedAttribute(attrId, origCompact, updated, changes);

        // return UI to normal view immediately
        renderAttributeDetail(attrId);

        window.open(issueUrl, '_blank', 'noopener');
      });
    }
  }



  // --- Load catalog once ---
  let catalogData = null;
  try {
    catalogData = await Catalog.loadCatalog();
  } catch (err) {
    console.error('Failed to load catalog.json:', err);
    if (datasetListEl) datasetListEl.textContent = 'Error loading catalog.';
    if (attributeListEl) attributeListEl.textContent = 'Error loading catalog.';
    return;
  }

  const allDatasets = catalogData.datasets || [];
  const allAttributes = catalogData.attributes || [];

  // ===========================
  // DATASET SUBMISSION MODAL
  // ===========================
  const newDatasetBtn = document.getElementById('newDatasetBtn');
  
  // Replace modal behavior with an editable page in the detail panel
  if (newDatasetBtn) {
    newDatasetBtn.addEventListener('click', () => {
      showDatasetsView();
      renderNewDatasetCreateForm();
    });
  }

  // ===========================
  // ATTRIBUTE SUBMISSION MODAL
  // ===========================
  const newAttributeBtn = document.getElementById('newAttributeBtn');

  if (newAttributeBtn) {
    newAttributeBtn.addEventListener('click', () => {
       // Replace old modal behavior with the new editable page
       showAttributesView();
       renderNewAttributeCreateForm();
    });
  }

  // ===========================
  // TAB SWITCHING
  // ===========================
  function showDatasetsView() {
    datasetsView.classList.remove('hidden');
    attributesView.classList.add('hidden');
    datasetsTabBtn.classList.add('active');
    attributesTabBtn.classList.remove('active');
  }

  function showAttributesView() {
    attributesView.classList.remove('hidden');
    datasetsView.classList.add('hidden');
    attributesTabBtn.classList.add('active');
    datasetsTabBtn.classList.remove('active');
  }

  if (datasetsTabBtn) datasetsTabBtn.addEventListener('click', showDatasetsView);
  if (attributesTabBtn) attributesTabBtn.addEventListener('click', showAttributesView);

  // ===========================
  // LIST RENDERING
  // ===========================
  function renderDatasetList(filterText = '') {
    if (!datasetListEl) return;
    const ft = filterText.trim().toLowerCase();

    const filtered = !ft
      ? allDatasets
      : allDatasets.filter((ds) => {
        const haystack = [ds.id, ds.title, ds.description, ds.agency_owner, ds.office_owner, ...(ds.topics || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(ft);
      });

    if (!filtered.length) {
      datasetListEl.innerHTML = '<p>No datasets found.</p>';
      return;
    }

    // Group datasets by parent service
    const serviceGroups = new Map(); // _parent_service -> { label, datasets[] }
    const standaloneDatasets = [];

    filtered.forEach((ds) => {
      if (ds._parent_service) {
        if (!serviceGroups.has(ds._parent_service)) {
          // Extract a friendly service name from the URL
          const serviceName = extractServiceNameFromUrl(ds._parent_service);
          serviceGroups.set(ds._parent_service, {
            label: serviceName,
            url: ds._parent_service,
            datasets: []
          });
        }
        serviceGroups.get(ds._parent_service).datasets.push(ds);
      } else {
        standaloneDatasets.push(ds);
      }
    });

    // Sort sublayers within each group by layer ID
    serviceGroups.forEach((group) => {
      group.datasets.sort((a, b) => (a._layer_id ?? 999) - (b._layer_id ?? 999));
    });

    const container = document.createElement('div');

    // Render grouped services first
    serviceGroups.forEach((group, serviceUrl) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'service-tree-group';

      // Check if any child is currently selected (to auto-expand)
      const hasSelectedChild = group.datasets.some(ds => ds.id === lastSelectedDatasetId);

      // Header (collapsible)
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'service-tree-header' + (hasSelectedChild ? ' is-expanded' : '');
      header.innerHTML = `
        <span class="service-tree-toggle">▶</span>
        <span class="service-tree-label" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</span>
        <span class="service-tree-count">${group.datasets.length} layers</span>
      `;

      // Children container
      const childrenEl = document.createElement('ul');
      childrenEl.className = 'service-tree-children' + (hasSelectedChild ? ' is-open' : '');

      // Toggle expand/collapse
      header.addEventListener('click', () => {
        header.classList.toggle('is-expanded');
        childrenEl.classList.toggle('is-open');
      });

      // Render child datasets
      group.datasets.forEach((ds) => {
        const li = document.createElement('li');
        li.className = 'list-item dataset-item';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item-button';
        btn.setAttribute('data-ds-id', ds.id);

        const geomIconHtml = getGeometryIconHTML(ds.geometry_type || '', 'geom-icon-list');
        const layerName = ds._layer_name || ds.title || ds.id;
        const layerId = ds._layer_id !== undefined ? ds._layer_id : '';

        btn.innerHTML = `
          ${geomIconHtml}
          <span class="list-item-label">${escapeHtml(layerName)}</span>
          ${layerId !== '' ? `<span class="sublayer-id">/${layerId}</span>` : ''}
        `;

        btn.addEventListener('click', () => {
          showDatasetsView();
          renderDatasetDetail(ds.id);
        });

        li.appendChild(btn);
        childrenEl.appendChild(li);
      });

      groupEl.appendChild(header);
      groupEl.appendChild(childrenEl);
      container.appendChild(groupEl);
    });

    // Render standalone datasets
    if (standaloneDatasets.length > 0) {
      const standaloneList = document.createElement('ul');
      standaloneDatasets.forEach((ds) => {
        const li = document.createElement('li');
        li.className = 'list-item dataset-item standalone-dataset';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item-button';
        btn.setAttribute('data-ds-id', ds.id);

        const geomIconHtml = getGeometryIconHTML(ds.geometry_type || '', 'geom-icon-list');

        btn.innerHTML = `
          ${geomIconHtml}
          <span class="list-item-label">${escapeHtml(ds.title || ds.id)}</span>
        `;

        btn.addEventListener('click', () => {
          showDatasetsView();
          renderDatasetDetail(ds.id);
        });

        li.appendChild(btn);
        standaloneList.appendChild(li);
      });
      container.appendChild(standaloneList);
    }

    datasetListEl.innerHTML = '';
    datasetListEl.appendChild(container);

   // keep active highlight in sync after re-render
   setActiveListButton(datasetListEl, (b) => b.getAttribute('data-ds-id') === lastSelectedDatasetId);
  }

  // Helper: Extract a friendly service name from an ArcGIS REST URL
  function extractServiceNameFromUrl(url) {
    if (!url) return 'Unknown Service';
    // Example: https://gis.blm.gov/arcgis/rest/services/admin_boundaries/BLM_Natl_AdminUnit_Generalized/FeatureServer
    // We want: "BLM_Natl_AdminUnit_Generalized"
    const match = url.match(/\/rest\/services\/(?:[^\/]+\/)?([^\/]+)\/(?:MapServer|FeatureServer|ImageServer)/i);
    if (match && match[1]) {
      // Replace underscores with spaces for readability
      return match[1].replace(/_/g, ' ');
    }
    // Fallback: return last path segment before service type
    const parts = url.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^(MapServer|FeatureServer|ImageServer)$/i.test(parts[i]) && parts[i - 1]) {
        return parts[i - 1].replace(/_/g, ' ');
      }
    }
    return 'Service';
  }

  function renderAttributeList(filterText = '') {
    if (!attributeListEl) return;
    const ft = filterText.trim().toLowerCase();

    const filtered = !ft
      ? allAttributes
      : allAttributes.filter((attr) => {
        const haystack = [attr.id, attr.label, attr.definition].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(ft);
      });

    if (!filtered.length) {
      attributeListEl.innerHTML = '<p>No attributes found.</p>';
      return;
    }

    const list = document.createElement('ul');
    filtered.forEach((attr) => {
      const li = document.createElement('li');
      li.className = 'list-item attribute-item';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-item-button';
      btn.setAttribute('data-attr-id', attr.id);
      btn.textContent = `${attr.id} – ${attr.label || ''}`;

      btn.addEventListener('click', () => {
        showAttributesView();
        renderAttributeDetail(attr.id);
      });

      li.appendChild(btn);
      list.appendChild(li);
    });

    attributeListEl.innerHTML = '';
    attributeListEl.appendChild(list);
  }

  // ===========================
  // DETAIL RENDERERS
  // ===========================
  function renderDatasetDetail(datasetId) {
    if (!datasetDetailEl) return;

  // Increment render generation so stale async operations (preview, coverage) bail out
  _renderGeneration++;
  const currentGeneration = _renderGeneration;

  // Destroy any existing ArcGIS MapView to prevent memory leaks
  if (currentMapView) {
    currentMapView.destroy();
    currentMapView = null;
  }

  // Browsing existing datasets should not animate.
  // Also make sure no prior FX classes linger from edit/create flows.
  datasetDetailEl.classList.remove('fx-enter', 'fx-animating');

    // update "last selected dataset" state whenever we render a dataset detail
    lastSelectedDatasetId = datasetId;

   // highlight active dataset in sidebar (if list is rendered)
   setActiveListButton(datasetListEl, (b) => b.getAttribute('data-ds-id') === datasetId);

    const dataset = Catalog.getDatasetById(datasetId);
    if (!dataset) {
      datasetDetailEl.classList.remove('hidden');
      datasetDetailEl.innerHTML = `<p>Dataset not found: ${escapeHtml(datasetId)}</p>`;
      return;
    }

    const geomIconHtml = getGeometryIconHTML(dataset.geometry_type || '', 'geom-icon-inline');
    const attrs = Catalog.getAttributesForDataset(dataset);

    let html = '';

    // Breadcrumb
    html += `
      <nav class="breadcrumb">
        <button type="button" class="breadcrumb-root" data-breadcrumb="datasets">Datasets</button>
        <span class="breadcrumb-separator">/</span>
        <span class="breadcrumb-current">${escapeHtml(dataset.title || dataset.id)}</span>
      </nav>
    `;

    html += `<h2>${escapeHtml(dataset.title || dataset.id)}</h2>`;
    if (dataset.description) html += `<p>${escapeHtml(dataset.description)}</p>`;

    // Data source legend (dev helper)
    html += `
      <div class="card" style="padding:0.6rem 0.85rem; margin-bottom:0.5rem; background:rgba(255,255,255,0.02);">
        <div style="font-size:0.8rem; color:var(--text-muted); display:flex; flex-wrap:wrap; gap:1rem; align-items:center;">
          <strong style="color:var(--text-main);">Data Source Legend:</strong>
          <span><span class="data-source-badge data-source-badge-manual">Manual</span> Entered in catalog.json</span>
          <span><span class="data-source-badge data-source-badge-auto">Auto</span> Fetched from ArcGIS REST API</span>
          <span><span class="data-source-badge data-source-badge-hybrid">Hybrid</span> Links manual to auto-detected</span>
        </div>
      </div>
    `;

    html += '<div class="card card-meta">';
    html += '<div class="card-header-row"><h3>Catalog Metadata</h3><span class="data-source-badge data-source-badge-manual">Manual</span></div>';
    html += `<p><strong>Database Object Name:</strong> ${escapeHtml(dataset.objname || '')}</p>`;
    html += `<p><strong>Geometry Type:</strong> ${geomIconHtml}${escapeHtml(dataset.geometry_type || '')}</p>`;
    html += `<p><strong>Agency Owner:</strong> ${escapeHtml(dataset.agency_owner || '')}</p>`;
    html += `<p><strong>Office Owner:</strong> ${escapeHtml(dataset.office_owner || '')}</p>`;
    html += `<p><strong>Contact Email:</strong> ${escapeHtml(dataset.contact_email || '')}</p>`;

    html += `<p><strong>Topics:</strong> ${Array.isArray(dataset.topics)
      ? dataset.topics.map((t) => `<span class="pill pill-topic">${escapeHtml(t)}</span>`).join(' ')
      : ''
      }</p>`;

    html += `<p><strong>Update Frequency:</strong> ${escapeHtml(dataset.update_frequency || '')}</p>`;
    html += `<p><strong>Status:</strong> ${escapeHtml(dataset.status || '')}</p>`;
    html += `<p><strong>Access Level:</strong> ${escapeHtml(dataset.access_level || '')}</p>`;

 html += `<p class="url-check-row" data-url-check-row data-url="${escapeHtml(dataset.public_web_service || '')}" data-url-status="idle">
   <strong>Public Web Service:</strong>
   <span class="url-status-icon" aria-hidden="true"></span>
   ${dataset.public_web_service
     ? `<a href="${dataset.public_web_service}" target="_blank" rel="noopener">${escapeHtml(dataset.public_web_service)}</a>`
     : ''
   }
 </p>`;

 html += `<p class="url-check-row" data-url-check-row data-url="${escapeHtml(dataset.internal_web_service || '')}" data-url-status="idle">
   <strong>Internal Web Service:</strong>
   <span class="url-status-icon" aria-hidden="true"></span>
   ${dataset.internal_web_service
     ? `<a href="${dataset.internal_web_service}" target="_blank" rel="noopener">${escapeHtml(dataset.internal_web_service)}</a>`
     : ''
   }
 </p>`;

 html += `<p class="url-check-row" data-url-check-row data-url="${escapeHtml(dataset.data_standard || '')}" data-url-status="idle">
   <strong>Data Standard:</strong>
   <span class="url-status-icon" aria-hidden="true"></span>
   ${dataset.data_standard
     ? `<a href="${dataset.data_standard}" target="_blank" rel="noopener">${escapeHtml(dataset.data_standard)}</a>`
     : ''
   }
 </p>`;

    if (dataset.notes) html += `<p><strong>Notes:</strong> ${escapeHtml(dataset.notes)}</p>`;
    html += '</div>';

    // Development & Status card
    html += '<div class="card card-development">';
    html += '<div class="card-header-row"><h3>Development & Status</h3><span class="data-source-badge data-source-badge-manual">Manual</span></div>';
    
    const stageLabels = {
      'planned': { label: 'Planned', class: 'stage-planned' },
      'in_development': { label: 'In Development', class: 'stage-dev' },
      'qa': { label: 'QA/Testing', class: 'stage-qa' },
      'production': { label: 'Production', class: 'stage-prod' },
      'deprecated': { label: 'Deprecated', class: 'stage-deprecated' }
    };
    const stage = dataset.development_stage || 'unknown';
    const stageInfo = stageLabels[stage] || { label: stage, class: '' };
    
    html += `<p><strong>Development Stage:</strong> <span class="stage-badge ${stageInfo.class}">${escapeHtml(stageInfo.label)}</span></p>`;
    
    if (dataset.target_release_date) {
      html += `<p><strong>Target Release Date:</strong> ${escapeHtml(dataset.target_release_date)}</p>`;
    }
    
    if (Array.isArray(dataset.blockers) && dataset.blockers.length) {
      html += `<p><strong>Blockers:</strong></p><ul>`;
      dataset.blockers.forEach(b => { html += `<li>${escapeHtml(b)}</li>`; });
      html += `</ul>`;
    }
    html += '</div>';

    // Coverage Map card (populated asynchronously by renderCoverageMapCard)
    html += '<div class="card card-coverage" id="coverageMapCard" style="border-left:4px solid #4CAF50;">';
    html += '<div class="card-header-row"><h3>\uD83D\uDDFA\uFE0F Coverage Map</h3><span class="data-source-badge data-source-badge-auto">Auto</span></div>';
    html += '<p class="text-muted" style="margin-bottom:0.5rem;font-size:0.85rem;">Spatial intersection with <a href="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0" target="_blank" rel="noopener">Census Bureau TIGER state boundaries</a>. A 2 km inward buffer is applied to each state boundary to exclude sliver intersections along shared borders. Counts are approximate.</p>';
    html += '<div data-cov-status class="coverage-status">Waiting for analysis\u2026</div>';
    html += '<div data-cov-content></div>';
    html += '</div>';

    // Maturity card
    const maturity = dataset.maturity || {};
    html += '<div class="card card-maturity">';
    html += '<div class="card-header-row"><h3>Data Maturity</h3><span class="data-source-badge data-source-badge-manual">Manual</span></div>';
    
    const tierLabels = {
      'bronze': { label: 'Bronze', class: 'tier-bronze', icon: '🥉' },
      'silver': { label: 'Silver', class: 'tier-silver', icon: '🥈' },
      'gold': { label: 'Gold', class: 'tier-gold', icon: '🥇' }
    };
    const docLabels = {
      'none': 'None',
      'minimal': 'Minimal',
      'partial': 'Partial',
      'complete': 'Complete'
    };
    
    const tier = maturity.quality_tier || '';
    const tierInfo = tierLabels[tier] || { label: tier || 'Unknown', class: '', icon: '' };
    const completeness = maturity.completeness;
    const docLevel = maturity.documentation || '';
    const docLabel = docLabels[docLevel] || docLevel || 'Unknown';
    
    html += `<div class="maturity-overview">`;
    html += `<div class="tier-badge-large ${tierInfo.class}">${tierInfo.icon}<span>${escapeHtml(tierInfo.label)}</span></div>`;
    html += `</div>`;
    
    if (completeness !== undefined) {
      const pct = Math.min(100, Math.max(0, Number(completeness) || 0));
      html += `
        <div class="completeness-bar-container">
          <div class="completeness-label"><strong>Completeness:</strong> ${pct}%</div>
          <div class="completeness-bar-track">
            <div class="completeness-bar-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }
    
    html += `<p><strong>Documentation:</strong> ${escapeHtml(docLabel)}</p>`;

    // Improvement suggestions based on current tier
    const improvementSuggestions = getMaturityImprovementSuggestions(tier, completeness, docLevel);
    if (improvementSuggestions.length > 0) {
      html += `<div class="maturity-suggestions">`;
      html += `<div class="suggestions-header"><strong>Suggestions to reach the next tier:</strong></div>`;
      html += `<ul class="suggestions-list">`;
      improvementSuggestions.forEach(suggestion => {
        html += `<li>${escapeHtml(suggestion)}</li>`;
      });
      html += `</ul></div>`;
    }

    html += '</div>';

    // Attributes + inline attribute details - only show if dataset has attributes
    if (attrs.length > 0) {
      html += `
        <div class="card-row">
          <div class="card card-attributes">
            <div class="card-header-row"><h3>Attributes</h3><span class="data-source-badge data-source-badge-hybrid">Hybrid</span></div>
            <ul>
      `;
      attrs.forEach((attr) => {
        html += `
            <li>
              <button type="button" class="link-button" data-attr-id="${escapeHtml(attr.id)}">
                ${escapeHtml(attr.id)} – ${escapeHtml(attr.label || '')}
              </button>
            </li>`;
      });
      html += `
            </ul>
          </div>
          <div class="card card-inline-attribute" id="inlineAttributeDetail">
            <h3>Attribute details</h3>
            <p>Select an attribute from the list to see its properties here without leaving this dataset.</p>
          </div>
        </div>
      `;
    }

    html += `
  <div class="card card-actions">
    <button type="button" class="suggest-button" data-edit-dataset="${escapeHtml(dataset.id)}">
      Suggest a change to this dataset
    </button>
  </div>
`;


// --- Public Web Service preview card (renders after URL checks) ---
html += `
  <div class="card card-map-preview" id="datasetPreviewCard">
    <div class="card-header-row"><h3>Public Web Service Preview</h3><span class="data-source-badge data-source-badge-auto">Auto</span></div>
    <div class="map-preview-status" data-preview-status>
      Checking Public Web Service…
    </div>
    <div class="map-preview-content" data-preview-content></div>
  </div>
`;


    datasetDetailEl.innerHTML = html;
    datasetDetailEl.classList.remove('hidden');

// Check URL status icons (async)
runUrlChecks(datasetDetailEl);

// Load service preview immediately (don't wait for URL health check)
maybeRenderPublicServicePreviewCard(datasetDetailEl, dataset.public_web_service, currentGeneration);

// Run coverage map analysis (async, renders into the #coverageMapCard placeholder)
renderCoverageMapCard(datasetDetailEl, dataset.public_web_service, currentGeneration);

    const editBtn = datasetDetailEl.querySelector('button[data-edit-dataset]');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const dsId = editBtn.getAttribute('data-edit-dataset');
        renderDatasetEditForm(dsId);
      });
    }


    const rootBtn = datasetDetailEl.querySelector('button[data-breadcrumb="datasets"]');
    if (rootBtn) rootBtn.addEventListener('click', showDatasetsView);

    const attrButtons = datasetDetailEl.querySelectorAll('button[data-attr-id]');
    attrButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const attrId = btn.getAttribute('data-attr-id');
        renderInlineAttributeDetail(attrId);
      });
    });

  }

  function renderInlineAttributeDetail(attrId) {
    if (!datasetDetailEl) return;

    const container = datasetDetailEl.querySelector('#inlineAttributeDetail');
    if (!container) return;

    const attribute = Catalog.getAttributeById(attrId);
    if (!attribute) {
      container.innerHTML = `
        <h3>Attribute details</h3>
        <p>Attribute not found: ${escapeHtml(attrId)}</p>
      `;
      return;
    }

    const datasetsUsing = Catalog.getDatasetsForAttribute(attrId) || [];

    let html = '';
    html += '<h3>Attribute details</h3>';
    html += `<h4>${escapeHtml(attribute.id)} – ${escapeHtml(attribute.label || '')}</h4>`;

    html += `<p><strong>Attribute Field Name:</strong> ${escapeHtml(attribute.id)}</p>`;
    html += `<p><strong>Attribute Label:</strong> ${escapeHtml(attribute.label || '')}</p>`;
    html += `<p><strong>Attribute Type:</strong> ${escapeHtml(attribute.type || '')}</p>`;
    html += `<p><strong>Attribute Definition:</strong> ${escapeHtml(attribute.definition || '')}</p>`;
    if (attribute.expected_value !== undefined) {
      html += `<p><strong>Example Expected Value:</strong> ${escapeHtml(String(attribute.expected_value))}</p>`;
    }

    if (attribute.type === 'enumerated' && Array.isArray(attribute.values) && attribute.values.length) {
      html += '<h4>Allowed values</h4>';
      html += `
        <table>
          <thead>
            <tr><th>Code</th><th>Label</th><th>Description</th></tr>
          </thead>
          <tbody>
      `;

      attribute.values.forEach((v) => {
        const code = v.code !== undefined ? String(v.code) : '';
        const label = v.label || '';
        const desc = v.description || '';
        html += `
          <tr>
            <td>${escapeHtml(code)}</td>
            <td>${escapeHtml(label)}</td>
            <td>${escapeHtml(desc)}</td>
          </tr>
        `;
      });

      html += `
          </tbody>
        </table>
      `;
    }

    html += '<h4>Datasets using this attribute</h4>';
    if (!datasetsUsing.length) {
      html += '<p>No other datasets currently reference this attribute.</p>';
    } else {
      html += '<ul>';
      datasetsUsing.forEach((ds) => {
        html += `
          <li>
            <button type="button" class="link-button" data-dataset-id="${escapeHtml(ds.id)}">
              ${escapeHtml(ds.title || ds.id)}
            </button>
          </li>
        `;
      });
      html += '</ul>';
    }

    html += `
      <p style="margin-top:0.6rem;">
        <button type="button" class="link-button" data-open-full-attribute="${escapeHtml(attribute.id)}">
          Open full attribute page
        </button>
      </p>
    `;

    container.innerHTML = html;

    const openFullBtn = container.querySelector('button[data-open-full-attribute]');
    if (openFullBtn) {
      openFullBtn.addEventListener('click', () => {
        const id = openFullBtn.getAttribute('data-open-full-attribute');
        showAttributesView();
        renderAttributeDetail(id);
      });
    }

    const dsButtons = container.querySelectorAll('button[data-dataset-id]');
    dsButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const dsId = btn.getAttribute('data-dataset-id');
        showDatasetsView();
        // keep lastSelectedDatasetId in sync on navigation
        lastSelectedDatasetId = dsId;
        renderDatasetDetail(dsId);
      });
    });
  }

  function renderAttributeDetail(attrId) {
    if (!attributeDetailEl) return;

  // Browsing existing attributes should not animate.
  // Also make sure no prior FX classes linger from edit/create flows.
  attributeDetailEl.classList.remove('fx-enter', 'fx-animating');

   // highlight active attribute in sidebar (if list is rendered)
   setActiveListButton(attributeListEl, (b) => b.getAttribute('data-attr-id') === attrId);

    const attribute = Catalog.getAttributeById(attrId);
    if (!attribute) {
      attributeDetailEl.classList.remove('hidden');
      attributeDetailEl.innerHTML = `<p>Attribute not found: ${escapeHtml(attrId)}</p>`;
      return;
    }

    const datasets = Catalog.getDatasetsForAttribute(attrId);

    let html = '';

    html += `
      <nav class="breadcrumb">
        <button type="button" class="breadcrumb-root" data-breadcrumb="attributes">Attributes</button>
        <span class="breadcrumb-separator">/</span>
        <span class="breadcrumb-current">${escapeHtml(attribute.id)}</span>
      </nav>
    `;

    html += `<h2>${escapeHtml(attribute.id)} – ${escapeHtml(attribute.label || '')}</h2>`;
    html += '<div class="card card-attribute-meta">';
    html += `<p><strong>Attribute Field Name:</strong> ${escapeHtml(attribute.id)}</p>`;
    html += `<p><strong>Attribute Label:</strong> ${escapeHtml(attribute.label || '')}</p>`;
    html += `<p><strong>Attribute Type:</strong> ${escapeHtml(attribute.type || '')}</p>`;
    html += `<p><strong>Attribute Definition:</strong> ${escapeHtml(attribute.definition || '')}</p>`;
    if (attribute.expected_value !== undefined) {
      html += `<p><strong>Example Expected Value:</strong> ${escapeHtml(String(attribute.expected_value))}</p>`;
    }
    html += '</div>';

    if (attribute.type === 'enumerated' && Array.isArray(attribute.values) && attribute.values.length) {
      html += '<div class="card card-enumerated">';
      html += '<h3>Allowed values</h3>';
      html += `
        <table>
          <thead>
            <tr><th>Code</th><th>Label</th><th>Description</th></tr>
          </thead>
          <tbody>
      `;
      attribute.values.forEach((v) => {
        const code = v.code !== undefined ? String(v.code) : '';
        const label = v.label || '';
        const desc = v.description || '';
        html += `
          <tr>
            <td>${escapeHtml(code)}</td>
            <td>${escapeHtml(label)}</td>
            <td>${escapeHtml(desc)}</td>
          </tr>
        `;
      });
      html += `
          </tbody>
        </table>
      `;
      html += '</div>';
    }

    html += '<div class="card card-attribute-datasets">';
    html += '<h3>Datasets using this attribute</h3>';
    if (!datasets.length) {
      html += '<p>No datasets currently reference this attribute.</p>';
    } else {
      html += '<ul>';
      datasets.forEach((ds) => {
        html += `
          <li>
            <button type="button" class="link-button" data-dataset-id="${escapeHtml(ds.id)}">
              ${escapeHtml(ds.title || ds.id)}
            </button>
          </li>`;
      });
      html += '</ul>';
    }
    html += '</div>';

    html += `
  <div class="card card-actions">
    <button type="button" class="suggest-button" data-edit-attribute="${escapeHtml(attribute.id)}">
      Suggest a change to this attribute
    </button>
  </div>
`;


    attributeDetailEl.innerHTML = html;
    attributeDetailEl.classList.remove('hidden');

    const editAttrBtn = attributeDetailEl.querySelector('button[data-edit-attribute]');
    if (editAttrBtn) {
      editAttrBtn.addEventListener('click', () => {
        const id = editAttrBtn.getAttribute('data-edit-attribute');
        renderAttributeEditForm(id);
      });
    }

    const rootBtn = attributeDetailEl.querySelector('button[data-breadcrumb="attributes"]');
    if (rootBtn) rootBtn.addEventListener('click', showAttributesView);

    const dsButtons = attributeDetailEl.querySelectorAll('button[data-dataset-id]');
    dsButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const dsId = btn.getAttribute('data-dataset-id');
        showDatasetsView();
        // keep lastSelectedDatasetId in sync on navigation
        lastSelectedDatasetId = dsId;
        renderDatasetDetail(dsId);
      });
    });
  }

  // ===========================
  // INITIAL RENDER + SEARCH
  // ===========================
  renderDatasetList();
  renderAttributeList();

  if (datasetSearchInput) {
    datasetSearchInput.addEventListener('input', () => renderDatasetList(datasetSearchInput.value));
  }
  if (attributeSearchInput) {
    attributeSearchInput.addEventListener('input', () => renderAttributeList(attributeSearchInput.value));
  }

// Initial render: only render the active tab's detail (Datasets tab is active by default)
  if (allDatasets.length) {
    lastSelectedDatasetId = allDatasets[0].id;
    renderDatasetDetail(allDatasets[0].id);
  }
// Attribute detail will render when user clicks the Attributes tab or an attribute link
});

// ====== UTILS ======
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Generate improvement suggestions based on current maturity tier and metrics
function getMaturityImprovementSuggestions(tier, completeness, docLevel) {
  const suggestions = [];
  const comp = Number(completeness) || 0;
  
  if (tier === 'gold') {
    // Already at highest tier - no suggestions
    return [];
  }
  
  if (tier === 'bronze') {
    // Bronze → Silver suggestions
    if (comp < 80) {
      suggestions.push(`Increase completeness from ${comp}% to at least 80% by filling in missing attribute values`);
    }
    if (!docLevel || docLevel === 'none' || docLevel === 'minimal') {
      suggestions.push('Improve documentation level to at least "Partial" by adding field descriptions and metadata');
    }
    suggestions.push('Ensure consistent attribute naming conventions across the dataset');
    suggestions.push('Add or verify contact information and data steward assignment');
  } else if (tier === 'silver') {
    // Silver → Gold suggestions
    if (comp < 90) {
      suggestions.push(`Increase completeness from ${comp}% to at least 90% by addressing remaining data gaps`);
    }
    if (docLevel !== 'complete') {
      suggestions.push('Achieve "Complete" documentation with full field definitions, lineage, and usage notes');
    }
    suggestions.push('Implement automated data quality checks and validation rules');
    suggestions.push('Establish a regular update schedule and document the update frequency');
  } else {
    // Unknown or no tier - general suggestions
    if (comp < 70) {
      suggestions.push('Improve data completeness by filling in missing values');
    }
    if (!docLevel || docLevel === 'none') {
      suggestions.push('Add basic documentation including field descriptions');
    }
    suggestions.push('Assign a quality tier (bronze/silver/gold) to track maturity');
  }
  
  return suggestions;
}

// Return HTML snippet for a geometry-type icon.
// Follows ArcGIS Online / modern GIS catalog visual conventions.
// contextClass: "geom-icon-list" (sidebar) or "geom-icon-inline" (detail).
function getGeometryIconHTML(geometryType, contextClass) {
  const geom = (geometryType || '').toUpperCase().trim();
  const base = 'geom-icon';
  const cls  = `${base} ${contextClass || ''}`.trim();

  // ── POINT: map-pin / location marker ──
  if (geom === 'POINT') {
    return `<span class="${cls} geom-type-point" title="Point"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.5"/>
      <circle cx="12" cy="9" r="2.5" fill="currentColor"/>
    </svg></span>`;
  }

  // ── MULTIPOINT: scattered location dots ──
  if (geom === 'MULTIPOINT') {
    return `<span class="${cls} geom-type-multipoint" title="Multipoint"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <circle cx="6"  cy="8"  r="2.5"/>
      <circle cx="17" cy="6"  r="2.5"/>
      <circle cx="10" cy="16" r="2.5"/>
      <circle cx="19" cy="17" r="2"/>
      <circle cx="4"  cy="18" r="1.5" opacity="0.5"/>
    </svg></span>`;
  }

  // ── POLYLINE / LINE: segmented path with vertex squares ──
  if (geom === 'POLYLINE' || geom === 'LINE') {
    return `<span class="${cls} geom-type-line" title="Polyline"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 19 L8 7 L16 15 L21 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="6.5" y="5.5" width="3" height="3" rx="0.5" fill="currentColor"/>
      <rect x="14.5" y="13.5" width="3" height="3" rx="0.5" fill="currentColor"/>
    </svg></span>`;
  }

  // ── POLYGON: irregular filled boundary shape ──
  if (geom === 'POLYGON') {
    return `<span class="${cls} geom-type-polygon" title="Polygon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 4 L19 3 L22 11 L17 21 L6 20 L2 12 Z" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="5" cy="4" r="1.5" fill="currentColor"/>
      <circle cx="19" cy="3" r="1.5" fill="currentColor"/>
      <circle cx="22" cy="11" r="1.5" fill="currentColor"/>
      <circle cx="17" cy="21" r="1.5" fill="currentColor"/>
      <circle cx="6" cy="20" r="1.5" fill="currentColor"/>
      <circle cx="2" cy="12" r="1.5" fill="currentColor"/>
    </svg></span>`;
  }

  // ── TABLE: non-spatial tabular data ──
  if (geom === 'TABLE') {
    return `<span class="${cls} geom-type-table" title="Table"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/>
      <rect x="2" y="3" width="20" height="5" rx="2" fill="currentColor" opacity="0.25"/>
      <line x1="2" y1="8"  x2="22" y2="8"  stroke="currentColor" stroke-width="1.5"/>
      <line x1="2" y1="13" x2="22" y2="13" stroke="currentColor" stroke-width="1"/>
      <line x1="2" y1="17" x2="22" y2="17" stroke="currentColor" stroke-width="1"/>
      <line x1="9" y1="8"  x2="9"  y2="21" stroke="currentColor" stroke-width="1"/>
    </svg></span>`;
  }

  // ── RASTER / IMAGE: pixel grid / checkerboard ──
  if (geom === 'RASTER' || geom === 'IMAGE') {
    return `<span class="${cls} geom-type-raster" title="Raster / Image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="20" height="20" rx="2" stroke="currentColor" stroke-width="1.5"/>
      <rect x="2"  y="2"  width="5" height="5" fill="currentColor" opacity="0.35"/>
      <rect x="12" y="2"  width="5" height="5" fill="currentColor" opacity="0.2"/>
      <rect x="7"  y="7"  width="5" height="5" fill="currentColor" opacity="0.45"/>
      <rect x="17" y="7"  width="5" height="5" fill="currentColor" opacity="0.3"/>
      <rect x="2"  y="12" width="5" height="5" fill="currentColor" opacity="0.2"/>
      <rect x="12" y="12" width="5" height="5" fill="currentColor" opacity="0.5"/>
      <rect x="7"  y="17" width="5" height="5" fill="currentColor" opacity="0.25"/>
      <rect x="17" y="17" width="5" height="5" fill="currentColor" opacity="0.15"/>
    </svg></span>`;
  }

  // ── Fallback: generic layer icon ──
  return `<span class="${cls} geom-type-unknown" title="${geom || 'Unknown'}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="6" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
    <rect x="5" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
  </svg></span>`;
}

