import { escapeHtml } from './utils.js';
import { normalizeServiceUrl, parseServiceAndLayerId, looksLikeArcGisService, getRenderGeneration } from './arcgis-preview.js';

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

export function getCoverageCache() { return _coverageAnalysisCache; }

// ── ArcGIS SDK query modules (loaded on-demand for coverage analysis) ──
let _esriQuery = null;
let _EsriQueryClass = null;
let _geometryEngine = null;

export function _loadCoverageQueryModules() {
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
export async function fetchCensusStateBoundaries() {
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
export async function queryFeatureCountInGeometry(serviceUrl, layerId, geometry) {
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
export async function runCoverageAnalysis(serviceUrl, layerId, states, onProgress) {
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

export function projectGeoToSVG(lon, lat, geoBounds, viewport) {
  const x = viewport.x + ((lon - geoBounds.minLon) / (geoBounds.maxLon - geoBounds.minLon)) * viewport.w;
  const y = viewport.y + (1 - (lat - geoBounds.minLat) / (geoBounds.maxLat - geoBounds.minLat)) * viewport.h;
  return [x, y];
}

export function polygonRingsToPath(rings, geoBounds, viewport) {
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
export function polygonLabelPoint(rings) {
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
export function buildCoverageMapSVG(analysisResults) {
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
export async function renderCoverageMapCard(hostEl, publicServiceUrl, generation, dataset) {
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

  // Check session cache (from prior live or pre-computed render)
  const cacheKey = `${url}__${layerId}`;
  if (_coverageAnalysisCache.has(cacheKey)) {
    const cached = _coverageAnalysisCache.get(cacheKey);
    paintCoverageResult(statusEl, contentEl, cached);
    return;
  }

  // Check for pre-computed coverage data from catalog.json
  if (dataset && dataset._coverage && dataset._coverage.states) {
    await renderCoverageFromPrecomputed(statusEl, contentEl, dataset._coverage, url, layerId, generation);
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
  if (generation !== getRenderGeneration()) return;

  // Step 2 — run spatial intersection counts
  statusEl.textContent = `Analyzing coverage across ${states.length} states\u2026`;
  let results;
  try {
    results = await runCoverageAnalysis(url, layerId, states, (done, total) => {
      if (generation !== getRenderGeneration()) return;
      statusEl.textContent = `Analyzing coverage: ${done} / ${total} states\u2026`;
    });
  } catch (err) {
    console.error('Coverage analysis failed:', err);
    statusEl.textContent = 'Coverage analysis failed \u2014 the service may not support spatial queries.';
    return;
  }

  // Bail if user navigated away during analysis
  if (generation !== getRenderGeneration()) return;

  _coverageAnalysisCache.set(cacheKey, results);
  paintCoverageResult(statusEl, contentEl, results);
}

export function paintCoverageResult(statusEl, contentEl, results) {
  const { svg, statesWithData, totalFeatures, totalStates, failedCount } =
    buildCoverageMapSVG(results);

  let summary = `${statesWithData} of ${totalStates} states with data \u00b7 ${totalFeatures.toLocaleString()} intersections`;
  if (failedCount > 0) summary += ` \u00b7 ${failedCount} state(s) could not be queried`;
  statusEl.textContent = summary;
  contentEl.innerHTML = svg;
}

/**
 * Render coverage map from pre-computed data stored in catalog.json.
 * Still needs Census state boundaries for SVG rendering (fetched & cached per session),
 * but skips the expensive per-state spatial intersection queries.
 */
export async function renderCoverageFromPrecomputed(statusEl, contentEl, coverageData, url, layerId, generation) {
  const generatedDate = coverageData.generated
    ? new Date(coverageData.generated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'unknown date';

  statusEl.textContent = `Loading pre-computed coverage (${generatedDate})\u2026`;

  // Fetch Census state boundaries for SVG rendering (cached per session)
  let states;
  try {
    states = await fetchCensusStateBoundaries();
  } catch (err) {
    console.error('Census state fetch failed:', err);
    // Fall back to text-only summary
    const entries = Object.entries(coverageData.states || {});
    const withData = entries.filter(([, c]) => c > 0).length;
    const total = entries.reduce((s, [, c]) => s + Math.max(0, c), 0);
    statusEl.textContent = `${withData} states with data \u00b7 ${total.toLocaleString()} intersections (pre-computed ${generatedDate}). Map unavailable \u2014 Census boundary fetch failed.`;
    return;
  }

  if (generation !== getRenderGeneration()) return;

  // Merge pre-computed counts onto state geometry objects
  const stateCountMap = coverageData.states;
  const results = states.map(s => ({
    ...s,
    count: stateCountMap[s.abbr] !== undefined ? stateCountMap[s.abbr] : 0,
  }));

  // Populate session cache so subsequent views reuse it
  const cacheKey = `${url}__${layerId}`;
  _coverageAnalysisCache.set(cacheKey, results);

  paintCoverageResult(statusEl, contentEl, results);

  // Append pre-computed note to the status line
  statusEl.textContent += ` (pre-computed ${generatedDate})`;
}
