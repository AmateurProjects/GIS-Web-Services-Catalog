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
      if (resp2 && resp2.type === 'opaque') return 'unknown';
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

function looksLikeArcGisService(url) {
  const u = String(url || '').toUpperCase();
  return u.includes('/ARCGIS/REST/SERVICES/') && (u.includes('/MAPSERVER') || u.includes('/FEATURESERVER'));
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
  const u = `${base}/${layerId}?f=pjson`;
  return fetchJsonWithTimeout(u);
}

async function fetchSampleRows(serviceUrl, layerId = 0, n = 8) {
  const base = normalizeServiceUrl(serviceUrl);
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'false',
    resultRecordCount: String(n),
    f: 'json',
  });
  const u = `${base}/${layerId}/query?${params.toString()}`;
  return fetchJsonWithTimeout(u);
}

// Fetch statistics for numeric/date fields (min, max, avg, stddev, count)
async function fetchFieldStatistics(serviceUrl, layerId = 0, fieldName, fieldType) {
  const base = normalizeServiceUrl(serviceUrl);
  const statTypes = ['min', 'max', 'avg', 'stddev', 'count'];
  const outStatistics = statTypes.map(t => ({
    statisticType: t,
    onStatisticField: fieldName,
    outStatisticFieldName: `${t}_${fieldName}`
  }));
  
  const params = new URLSearchParams({
    where: '1=1',
    outStatistics: JSON.stringify(outStatistics),
    f: 'json',
  });
  const u = `${base}/${layerId}/query?${params.toString()}`;
  return fetchJsonWithTimeout(u);
}

// Fetch unique value counts for a field (for histograms/value distribution)
async function fetchFieldValueCounts(serviceUrl, layerId = 0, fieldName, maxValues = 50) {
  const base = normalizeServiceUrl(serviceUrl);
  const params = new URLSearchParams({
    where: '1=1',
    outFields: fieldName,
    groupByFieldsForStatistics: fieldName,
    outStatistics: JSON.stringify([{
      statisticType: 'count',
      onStatisticField: fieldName,
      outStatisticFieldName: 'value_count'
    }]),
    orderByFields: 'value_count DESC',
    resultRecordCount: String(maxValues),
    f: 'json',
  });
  const u = `${base}/${layerId}/query?${params.toString()}`;
  return fetchJsonWithTimeout(u);
}

// Determine if a field type is numeric (for statistics)
function isNumericFieldType(esriType) {
  const t = String(esriType || '').toUpperCase();
  return t.includes('INTEGER') || t.includes('DOUBLE') || t.includes('FLOAT') || t.includes('SINGLE') || t.includes('SMALL');
}

// Determine if a field type is date
function isDateFieldType(esriType) {
  return String(esriType || '').toUpperCase().includes('DATE');
}

// Build a simple inline histogram bar chart HTML
function buildHistogramHTML(valueCounts, fieldName, totalCount) {
  if (!valueCounts || !valueCounts.length) return '<p class="text-muted">No data available</p>';
  
  const maxCount = Math.max(...valueCounts.map(v => v.count || 0));
  
  let html = '<div class="histogram-chart">';
  valueCounts.slice(0, 10).forEach(v => {
    const label = v.value !== null && v.value !== undefined ? String(v.value) : '(null)';
    const count = v.count || 0;
    const pct = maxCount > 0 ? (count / maxCount * 100) : 0;
    const pctOfTotal = totalCount > 0 ? ((count / totalCount) * 100).toFixed(1) : '0';
    
    html += `
      <div class="histogram-row">
        <div class="histogram-label" title="${escapeHtml(label)}">${escapeHtml(label.length > 20 ? label.slice(0, 18) + '...' : label)}</div>
        <div class="histogram-bar-container">
          <div class="histogram-bar" style="width: ${pct}%"></div>
        </div>
        <div class="histogram-count">${count.toLocaleString()} (${pctOfTotal}%)</div>
      </div>
    `;
  });
  html += '</div>';
  
  if (valueCounts.length > 10) {
    html += `<p class="text-muted" style="margin-top:0.5rem;">Showing top 10 of ${valueCounts.length} unique values</p>`;
  }
  
  return html;
}

// Build statistics summary HTML
function buildStatisticsHTML(stats, fieldName) {
  if (!stats) return '<p class="text-muted">Statistics unavailable</p>';
  
  const formatNum = (n) => {
    if (n === null || n === undefined) return '—';
    if (typeof n === 'number') return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return String(n);
  };
  
  return `
    <div class="stats-grid">
      <div class="stat-item"><span class="stat-label">Min</span><span class="stat-value">${formatNum(stats.min)}</span></div>
      <div class="stat-item"><span class="stat-label">Max</span><span class="stat-value">${formatNum(stats.max)}</span></div>
      <div class="stat-item"><span class="stat-label">Avg</span><span class="stat-value">${formatNum(stats.avg)}</span></div>
      <div class="stat-item"><span class="stat-label">Std Dev</span><span class="stat-value">${formatNum(stats.stddev)}</span></div>
      <div class="stat-item"><span class="stat-label">Count</span><span class="stat-value">${formatNum(stats.count)}</span></div>
    </div>
  `;
}

function buildExportImageUrl(mapServerUrl, extent) {
  const base = normalizeServiceUrl(mapServerUrl);
  const wkid = extent?.spatialReference?.wkid || 4326;
  const bbox = [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(',');
  const params = new URLSearchParams({
    bbox,
    bboxSR: String(wkid),
    imageSR: String(wkid),
    size: '1000,520',
    format: 'png',
    transparent: 'true',
    f: 'image',
  });
  return `${base}/export?${params.toString()}`;
}

function renderKeyValueRows(obj) {
  // simple helper to keep markup tidy
  const rows = Object.entries(obj || {})
    .filter(([_, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `<div class="kv-row"><div class="kv-k">${escapeHtml(k)}</div><div class="kv-v">${escapeHtml(String(v))}</div></div>`);
  return rows.join('');
}

function isUrlStatusOk(hostEl, url) {
  const u = normalizeServiceUrl(url);
  if (!u) return false;
  const row =
    hostEl.querySelector(`[data-url-check-row][data-url="${CSS.escape(u)}"]`) ||
    hostEl.querySelector(`[data-url-check-row][data-url="${CSS.escape(url)}"]`);
  const status = row ? row.getAttribute('data-url-status') : 'unknown';
  return status === 'ok';
}

// Initialize interactive ArcGIS map for dataset preview
let currentMapView = null;
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

      // Zoom to layer extent when loaded
      layer.when(function() {
        if (layer.fullExtent) {
          currentMapView.goTo(layer.fullExtent).catch(function(err) {
            console.warn('Could not zoom to layer extent:', err);
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

async function maybeRenderPublicServicePreviewCard(hostEl, publicUrl) {
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

  if (!isUrlStatusOk(hostEl, url)) {
    statusEl.textContent = 'Public Web Service is not verified as reachable — preview unavailable.';
    return;
  }

  if (!looksLikeArcGisService(url)) {
    statusEl.textContent = 'Public Web Service is reachable, but not recognized as an ArcGIS REST Map/Feature service.';
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
    const serviceJson = await fetchServiceJson(url);

    // Choose a layer for fields/sample (default to first layer id if available)
    const layerId = (serviceJson.layers && serviceJson.layers.length)
      ? (serviceJson.layers[0].id ?? 0)
      : 0;

    // Static image works for MapServer. For FeatureServer, try to use /0 for export if URL ends with FeatureServer.
    let exportUrl = '';
    const upper = url.toUpperCase();
    if (upper.includes('/MAPSERVER')) {
      if (serviceJson.fullExtent) exportUrl = buildExportImageUrl(url, serviceJson.fullExtent);
    } else if (upper.includes('/FEATURESERVER')) {
      // Some FeatureServers also support export via the corresponding MapServer; if not, we just skip the image.
      // We'll still show metadata/fields/sample.
      exportUrl = '';
    }

    // Layer fields + sample rows (best-effort)
    let layerJson = null;
    let sampleJson = null;
    try { layerJson = await fetchLayerJson(url, layerId); } catch {}
    try { sampleJson = await fetchSampleRows(url, layerId, 10); } catch {}

    // Build content
    const meta = {
      'Service Name': serviceJson.mapName || serviceJson.name || '',
      'Service Type': upper.includes('/MAPSERVER') ? 'MapServer' : (upper.includes('/FEATURESERVER') ? 'FeatureServer' : (upper.includes('/IMAGESERVER') ? 'ImageServer' : 'Unknown')),
      'Spatial Reference (WKID)': serviceJson.spatialReference?.wkid || serviceJson.fullExtent?.spatialReference?.wkid || '',
      'Layer Count': Array.isArray(serviceJson.layers) ? String(serviceJson.layers.length) : '',
      'Capabilities': serviceJson.capabilities || '',
    };

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
        <div style="font-weight:600; margin-bottom:0.5rem;">Service Metadata (from REST endpoint)</div>
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

    // Image (if available)
    if (exportUrl) {
      html += `
        <div class="card" style="margin-top:0.75rem;">
          <div style="font-weight:600; margin-bottom:0.5rem;">Map extent preview</div>
          <img src="${escapeHtml(exportUrl)}" alt="Map preview"
               style="width:100%; height:auto; border-radius:12px; display:block;" />
          <div style="margin-top:0.5rem; color:var(--text-muted); font-size:0.95rem;">
            Rendered from the service’s full extent.
          </div>
        </div>
      `;
    }

    // Interactive ArcGIS Map View
    const mapServiceUrl = url;
    const mapLayerId = layerId;
    html += `
      <div class="card" style="margin-top:0.75rem;">
        <div style="font-weight:600; margin-bottom:0.5rem;">Interactive Map</div>
        <div style="color:var(--text-muted); margin-bottom:0.5rem; font-size:0.9rem;">Pan and zoom to explore the dataset</div>
        <div id="arcgisMapContainer" 
             data-service-url="${escapeHtml(mapServiceUrl)}" 
             data-layer-id="${mapLayerId}"
             style="width:100%; height:400px; border-radius:12px; overflow:hidden; background:#e0e0e0;"></div>
      </div>
    `;

    // Metadata
    html += `
      <div class="card" style="margin-top:0.75rem;">
        <div style="font-weight:600; margin-bottom:0.5rem;">Service summary</div>
        <div class="kv">${renderKeyValueRows(meta)}</div>
        <div style="margin-top:0.5rem;">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open service</a>
        </div>
      </div>
    `;

    // Fields summary
    if (layerJson && Array.isArray(layerJson.fields) && layerJson.fields.length) {
      const topFields = layerJson.fields.slice(0, 14);
      html += `
        <div class="card" style="margin-top:0.75rem;">
          <div style="font-weight:600; margin-bottom:0.5rem;">Fields (layer ${escapeHtml(String(layerId))})</div>
          <div style="color:var(--text-muted); margin-bottom:0.5rem;">Showing ${topFields.length} of ${layerJson.fields.length}</div>
          <ul style="margin:0; padding-left:1.1rem;">
            ${topFields.map(f => `<li><code>${escapeHtml(f.name)}</code>${f.alias ? ` — ${escapeHtml(f.alias)}` : ''} <span style="color:var(--text-muted);">(${escapeHtml(f.type || '')})</span></li>`).join('')}
          </ul>
        </div>
      `;
    }

    // Sample table
    if (sampleJson && Array.isArray(sampleJson.features) && sampleJson.features.length) {
      const rows = sampleJson.features.map(ft => ft.attributes || {}).slice(0, 10);
      const cols = Object.keys(rows[0] || {}).slice(0, 10); // keep table compact
      if (cols.length) {
        html += `
          <div class="card" style="margin-top:0.75rem;">
            <div style="font-weight:600; margin-bottom:0.5rem;">Sample records (layer ${escapeHtml(String(layerId))})</div>
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

    // Field Statistics & Histograms section
    if (layerJson && Array.isArray(layerJson.fields) && layerJson.fields.length) {
      html += `
        <div class="card" style="margin-top:0.75rem;">
          <div style="font-weight:600; margin-bottom:0.5rem;">Field Statistics & Histograms</div>
          <p style="color:var(--text-muted); margin-bottom:0.75rem;">Select a field to view statistics and value distribution.</p>
          <div class="field-stats-selector">
            <select id="fieldStatsSelect" class="field-stats-dropdown">
              <option value="">— Select a field —</option>
              ${layerJson.fields.map(f => `<option value="${escapeHtml(f.name)}" data-field-type="${escapeHtml(f.type || '')}">${escapeHtml(f.name)}${f.alias ? ` (${escapeHtml(f.alias)})` : ''}</option>`).join('')}
            </select>
            <button type="button" class="btn primary" id="loadFieldStatsBtn">Load Statistics</button>
          </div>
          <div id="fieldStatsContent" class="field-stats-content"></div>
        </div>
      `;
    }

    contentEl.innerHTML = html;
    statusEl.textContent = 'Preview loaded.';

    // Initialize interactive ArcGIS map
    initializeArcGISMap(url, layerId);

    // Wire up the field statistics loader
    const fieldSelect = contentEl.querySelector('#fieldStatsSelect');
    const loadStatsBtn = contentEl.querySelector('#loadFieldStatsBtn');
    const statsContent = contentEl.querySelector('#fieldStatsContent');
    
    if (fieldSelect && loadStatsBtn && statsContent) {
      loadStatsBtn.addEventListener('click', async () => {
        const fieldName = fieldSelect.value;
        if (!fieldName) {
          statsContent.innerHTML = '<p class="text-muted">Please select a field.</p>';
          return;
        }
        
        const fieldType = fieldSelect.options[fieldSelect.selectedIndex].getAttribute('data-field-type') || '';
        statsContent.innerHTML = '<p>Loading statistics...</p>';
        
        try {
          const isNumeric = isNumericFieldType(fieldType);
          const isDate = isDateFieldType(fieldType);
          
          let statsHtml = `<h4 style="margin-top:0.75rem;">${escapeHtml(fieldName)}</h4>`;
          statsHtml += `<p style="color:var(--text-muted);">Type: ${escapeHtml(fieldType)}</p>`;
          
          // For numeric/date fields, fetch statistics
          if (isNumeric || isDate) {
            try {
              const statsJson = await fetchFieldStatistics(url, layerId, fieldName, fieldType);
              if (statsJson && Array.isArray(statsJson.features) && statsJson.features.length) {
                const statsAttrs = statsJson.features[0].attributes || {};
                const stats = {
                  min: statsAttrs[`min_${fieldName}`],
                  max: statsAttrs[`max_${fieldName}`],
                  avg: statsAttrs[`avg_${fieldName}`],
                  stddev: statsAttrs[`stddev_${fieldName}`],
                  count: statsAttrs[`count_${fieldName}`]
                };
                statsHtml += '<div style="margin-top:0.5rem;"><strong>Statistics</strong></div>';
                statsHtml += buildStatisticsHTML(stats, fieldName);
              }
            } catch (e) {
              console.warn('Could not fetch statistics:', e);
            }
          }
          
          // Fetch value distribution (histogram)
          try {
            const valueCountsJson = await fetchFieldValueCounts(url, layerId, fieldName, 50);
            if (valueCountsJson && Array.isArray(valueCountsJson.features) && valueCountsJson.features.length) {
              const valueCounts = valueCountsJson.features.map(f => ({
                value: f.attributes ? f.attributes[fieldName] : null,
                count: f.attributes ? f.attributes['value_count'] : 0
              }));
              const totalCount = valueCounts.reduce((sum, v) => sum + (v.count || 0), 0);
              
              statsHtml += '<div style="margin-top:1rem;"><strong>Value Distribution</strong></div>';
              statsHtml += buildHistogramHTML(valueCounts, fieldName, totalCount);
            }
          } catch (e) {
            console.warn('Could not fetch value counts:', e);
            statsHtml += '<p class="text-muted">Could not load value distribution.</p>';
          }
          
          statsContent.innerHTML = statsHtml;
        } catch (err) {
          console.error('Stats loading error:', err);
          statsContent.innerHTML = '<p class="text-muted">Failed to load statistics.</p>';
        }
      });
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
  let catalog;
  let catalogData = null;
  try {
    catalog = await Catalog.loadCatalog();
    catalogData = catalog;
  } catch (err) {
    console.error('Failed to load catalog.json:', err);
    if (datasetListEl) datasetListEl.textContent = 'Error loading catalog.';
    if (attributeListEl) attributeListEl.textContent = 'Error loading catalog.';
    return;
  }

  const allDatasets = catalog.datasets || [];
  const allAttributes = catalog.attributes || [];

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

    const list = document.createElement('ul');
    filtered.forEach((ds) => {
      const li = document.createElement('li');
      li.className = 'list-item dataset-item';

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
      list.appendChild(li);
    });

    datasetListEl.innerHTML = '';
    datasetListEl.appendChild(list);

   // keep active highlight in sync after re-render
   setActiveListButton(datasetListEl, (b) => b.getAttribute('data-ds-id') === lastSelectedDatasetId);
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

    html += '<div class="card card-meta">';
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
    html += '<h3>Development & Status</h3>';
    
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

    // National Scale Suitability card
    html += '<div class="card card-scale">';
    html += '<h3>National Scale Suitability</h3>';
    
    const scaleLabels = {
      'national': { label: 'National', class: 'scale-national', icon: '🌎' },
      'regional': { label: 'Regional', class: 'scale-regional', icon: '🗺️' },
      'local': { label: 'Local', class: 'scale-local', icon: '📍' }
    };
    const coverageLabels = {
      'nationwide': 'Nationwide (all 50 states)',
      'multi_state': 'Multi-state',
      'single_state': 'Single state',
      'partial': 'Partial coverage'
    };
    
    const scaleVal = dataset.scale_suitability || '';
    const scaleInfo = scaleLabels[scaleVal] || { label: scaleVal || 'Unknown', class: '', icon: '' };
    const coverageVal = dataset.coverage || '';
    const coverageLabel = coverageLabels[coverageVal] || coverageVal || 'Unknown';
    
    html += `<p><strong>Scale Suitability:</strong> <span class="scale-badge ${scaleInfo.class}">${scaleInfo.icon} ${escapeHtml(scaleInfo.label)}</span></p>`;
    html += `<p><strong>Coverage:</strong> ${escapeHtml(coverageLabel)}</p>`;
    
    const wmCompat = dataset.web_mercator_compatible;
    if (wmCompat !== undefined) {
      html += `<p><strong>Web Mercator Compatible:</strong> ${wmCompat ? '✅ Yes' : '❌ No'}</p>`;
    }
    
    if (dataset.performance_notes) {
      html += `<p><strong>Performance Notes:</strong> ${escapeHtml(dataset.performance_notes)}</p>`;
    }
    html += '</div>';

    // Maturity card
    const maturity = dataset.maturity || {};
    html += '<div class="card card-maturity">';
    html += '<h3>Data Maturity</h3>';
    
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
            <h3>Attributes</h3>
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
    <button type="button" class="export-button" data-export-schema="${escapeHtml(dataset.id)}">
      Export ArcGIS schema (Python)
    </button>
  </div>
`;


// --- Public Web Service preview card (renders after URL checks) ---
html += `
  <div class="card card-map-preview" id="datasetPreviewCard">
    <h3>Public Web Service preview</h3>
    <div class="map-preview-status" data-preview-status>
      Checking Public Web Service…
    </div>
    <div class="map-preview-content" data-preview-content></div>
  </div>
`;


    datasetDetailEl.innerHTML = html;
    datasetDetailEl.classList.remove('hidden');

// Check URL status icons (async)
runUrlChecks(datasetDetailEl).then(() => {
  maybeRenderPublicServicePreviewCard(datasetDetailEl, dataset.public_web_service);
});



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

    const exportBtn = datasetDetailEl.querySelector('button[data-export-schema]');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const dsId = exportBtn.getAttribute('data-export-schema');
        const ds = Catalog.getDatasetById(dsId);
        if (!ds) return;
        const attrsForDs = Catalog.getAttributesForDataset(ds);
        const script = buildArcGisSchemaPython(ds, attrsForDs);
        downloadTextFile(script, `${ds.id}_schema_arcpy.py`);
      });
    }
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

// Return HTML snippet for a geometry icon based on geometry_type
// contextClass should be either "geom-icon-list" or "geom-icon-inline"
function getGeometryIconHTML(geometryType, contextClass) {
  const geom = (geometryType || '').toUpperCase().trim();

  const baseClass = 'geom-icon';
  const fullClass = `${baseClass} ${contextClass || ''}`.trim();

  if (geom === 'POLYGON') {
    return `<span class="${fullClass} geom-poly"></span>`;
  }

  let symbol = '';
  if (geom === 'POINT' || geom === 'MULTIPOINT') {
    symbol = '•';
  } else if (geom === 'POLYLINE' || geom === 'LINE') {
    symbol = '〰️';
  } else if (geom === 'TABLE') {
    symbol = '▦';
  } else {
    symbol = '';
  }

  return `<span class="${fullClass}">${symbol}</span>`;
}

// Build ArcGIS Python schema script for a dataset
function buildArcGisSchemaPython(dataset, attrs) {
  const lines = [];
  const dsId = dataset.id || '';
  const objname = dataset.objname || dsId;

  lines.push('# -*- coding: utf-8 -*-');
  lines.push('# Auto-generated ArcGIS schema script from Public Lands National GIS Data Catalog');
  lines.push(`# Dataset ID: ${dsId}`);
  if (dataset.title) lines.push(`# Title: ${dataset.title}`);
  if (dataset.description) lines.push(`# Description: ${dataset.description}`);
  lines.push('');
  lines.push('import arcpy');
  lines.push('');
  lines.push('# TODO: Update these paths and settings before running');
  lines.push('gdb = r"C:\\path\\to\\your.gdb"');
  lines.push(`fc_name = "${objname}"`);

  const proj = dataset.projection || '';
  const epsgMatch = proj.match(/EPSG:(\d+)/i);

  const geomType = (dataset.geometry_type || 'POLYGON').toUpperCase();
  lines.push(`geometry_type = "${geomType}"  # e.g. "POINT", "POLYLINE", "POLYGON"`);

  if (epsgMatch) {
    lines.push(`spatial_reference = arcpy.SpatialReference(${epsgMatch[1]})  # from ${proj}`);
  } else {
    lines.push('spatial_reference = None  # TODO: set a spatial reference if desired');
  }

  lines.push('');
  lines.push('# Create the feature class');
  lines.push('out_fc = arcpy.management.CreateFeatureclass(');
  lines.push('    gdb,');
  lines.push('    fc_name,');
  lines.push('    geometry_type,');
  lines.push('    spatial_reference=spatial_reference');
  lines.push(')[0]');
  lines.push('');
  lines.push('# Define fields: (name, type, alias, length, domain)');
  lines.push('fields = [');

  const enumDomainComments = [];

  attrs.forEach((attr) => {
    const fieldInfo = mapAttributeToArcGisField(attr);

    const name = attr.id || '';
    const alias = attr.label || '';
    const type = fieldInfo.type;
    const length = fieldInfo.length;
    const domain = 'None';

    const safeAlias = alias.replace(/"/g, '""');

    lines.push(`    ("${name}", "${type}", "${safeAlias}", ${length}, ${domain}),`);

    if (attr.type === 'enumerated' && Array.isArray(attr.values) && attr.values.length) {
      const commentLines = [];
      commentLines.push(`# Domain suggestion for ${name} (${alias}):`);
      attr.values.forEach((v) => {
        const code = v.code !== undefined ? String(v.code) : '';
        const label = v.label || '';
        const desc = v.description || '';
        commentLines.push(`#   ${code} = ${label}  -  ${desc}`);
      });
      enumDomainComments.push(commentLines.join('\n'));
    }
  });

  lines.push(']');
  lines.push('');
  lines.push('# Add fields to the feature class');
  lines.push('for name, ftype, alias, length, domain in fields:');
  lines.push('    kwargs = {"field_alias": alias}');
  lines.push('    if length is not None and ftype == "TEXT":');
  lines.push('        kwargs["field_length"] = length');
  lines.push('    if domain is not None and domain != "None":');
  lines.push('        kwargs["field_domain"] = domain');
  lines.push('    arcpy.management.AddField(out_fc, name, ftype, **kwargs)');
  lines.push('');

  if (enumDomainComments.length) {
    lines.push('# ---------------------------------------------------------------------------');
    lines.push('# Suggested coded value domains for enumerated fields');
    lines.push('# You can use these comments to create geodatabase domains manually:');
    lines.push('# ---------------------------------------------------------------------------');
    enumDomainComments.forEach((block) => {
      lines.push(block);
      lines.push('');
    });
  }

  return lines.join('\n');
}

function mapAttributeToArcGisField(attr) {
  const t = (attr.type || '').toLowerCase();
  switch (t) {
    case 'string':
      return { type: 'TEXT', length: 255 };
    case 'integer':
      return { type: 'LONG', length: null };
    case 'float':
      return { type: 'DOUBLE', length: null };
    case 'boolean':
      return { type: 'SHORT', length: null };
    case 'date':
      return { type: 'DATE', length: null };
    case 'enumerated':
      return { type: 'LONG', length: null };
    default:
      return { type: 'TEXT', length: 255 };
  }
}

function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
