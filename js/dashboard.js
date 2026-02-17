// ===========================
// DASHBOARD RENDERER (ES Module)
// ===========================
import { state, els } from './state.js';
import { escapeHtml } from './utils.js';
import { showDatasetsView } from './navigation.js';
import { applyDashboardFilter } from './filters.js';
import { fetchPendingDatasetRequests, parseRequestedDatasetName, parseRequestedDescription } from './github-api.js';
import { checkUrlStatusDetailed } from './url-check.js';

let _renderDatasetDetail = null;
export function registerDashboardCallbacks({ renderDatasetDetail }) {
  _renderDatasetDetail = renderDatasetDetail;
}

export function renderDashboard() {
    if (!els.dashboardContentEl) return;

    const ds = state.allDatasets;
    const totalDatasets = ds.length;

    // ── Unique parent services ──
    const parentServices = new Set();
    ds.forEach(d => {
      if (d._parent_service) parentServices.add(d._parent_service);
      else if (d.public_web_service) parentServices.add(d.public_web_service);
    });
    const totalServices = parentServices.size;

    // ── Stage counts ──
    const stageCounts = { planned: 0, in_development: 0, qa: 0, production: 0, deprecated: 0, unknown: 0 };
    ds.forEach(d => {
      const s = d.development_stage || 'unknown';
      if (stageCounts[s] !== undefined) stageCounts[s]++;
      else stageCounts.unknown++;
    });

    // ── Tier counts ──
    const tierCounts = { gold: 0, silver: 0, bronze: 0, unassigned: 0 };
    ds.forEach(d => {
      const t = (d.maturity && d.maturity.quality_tier) || '';
      if (tierCounts[t] !== undefined) tierCounts[t]++;
      else tierCounts.unassigned++;
    });

    // ── Geometry type counts ──
    const geomCounts = {};
    ds.forEach(d => {
      const g = (d.geometry_type || 'UNKNOWN').toUpperCase();
      geomCounts[g] = (geomCounts[g] || 0) + 1;
    });

    // ── Coverage analysis ──
    let datasetsWithCoverage = 0;
    let nationwideCoverage = 0;
    let partialCoverage = 0;
    let noCoverageData = 0;
    ds.forEach(d => {
      if (d._coverage && d._coverage.states) {
        datasetsWithCoverage++;
        if (d._coverage.statesWithData >= 45) nationwideCoverage++;
        else partialCoverage++;
      } else {
        noCoverageData++;
      }
    });

    // ── Average completeness ──
    let compSum = 0, compCount = 0;
    ds.forEach(d => {
      if (d.maturity && typeof d.maturity.completeness === 'number') {
        compSum += d.maturity.completeness;
        compCount++;
      }
    });
    const avgCompleteness = compCount > 0 ? Math.round(compSum / compCount) : 0;

    // ── Agency / Office breakdown ──
    const officeCounts = {};
    ds.forEach(d => {
      const o = d.office_owner || 'Unknown';
      officeCounts[o] = (officeCounts[o] || 0) + 1;
    });

    // ── Datasets sorted by completeness (lowest first — attention needed) ──
    const lowCompleteness = ds
      .filter(d => d.maturity && typeof d.maturity.completeness === 'number')
      .sort((a, b) => a.maturity.completeness - b.maturity.completeness)
      .slice(0, 5);

    // ── Datasets with coverage gaps (fewest states) ──
    // Exclude 0% coverage — those are often datasets that haven't been analyzed
    // or have non-spatial data, not necessarily real gaps.
    const coverageGaps = ds
      .filter(d => d._coverage && d._coverage.states && d.coverage === 'nationwide')
      .map(d => {
        const statesWithData = d._coverage.statesWithData || 0;
        return { ...d, _statesWithData: statesWithData };
      })
      .filter(d => d._statesWithData > 0)
      .sort((a, b) => a._statesWithData - b._statesWithData)
      .slice(0, 5);

    // ── Build HTML ──
    let html = '';

    // Header
    html += `
      <div class="dashboard-header">
        <h2>Catalog Dashboard</h2>
        <p>Enterprise overview of BLM GIS web service health, maturity, and coverage.</p>
      </div>
    `;

    // ── KPI Cards ──
    html += `<div class="dashboard-kpi-row">`;

    // Total Datasets
    html += `
      <div class="kpi-card">
        <div class="kpi-card-accent" style="background: var(--accent);"></div>
        <div class="kpi-value" style="color: var(--accent);">${totalDatasets}</div>
        <div class="kpi-label">Total Datasets</div>
        <div class="kpi-sublabel">${totalServices} service${totalServices !== 1 ? 's' : ''}</div>
      </div>
    `;

    // Production
    html += `
      <div class="kpi-card" data-dash-filter="stage" data-dash-value="production">
        <div class="kpi-card-accent" style="background: var(--green);"></div>
        <div class="kpi-value" style="color: var(--green);">${stageCounts.production}</div>
        <div class="kpi-label">Production</div>
        <div class="kpi-sublabel">${totalDatasets > 0 ? Math.round(stageCounts.production / totalDatasets * 100) : 0}% of catalog</div>
      </div>
    `;

    // Gold Tier
    html += `
      <div class="kpi-card" data-dash-filter="tier" data-dash-value="gold">
        <div class="kpi-card-accent" style="background: #fde047;"></div>
        <div class="kpi-value" style="color: #fde047;">${tierCounts.gold}</div>
        <div class="kpi-label">Gold Tier</div>
        <div class="kpi-sublabel">${tierCounts.silver} silver · ${tierCounts.bronze} bronze</div>
      </div>
    `;

    // Average Completeness
    html += `
      <div class="kpi-card">
        <div class="kpi-card-accent" style="background: var(--purple);"></div>
        <div class="kpi-value" style="color: var(--purple);">${avgCompleteness}%</div>
        <div class="kpi-label">Avg Completeness</div>
        <div class="kpi-sublabel">${compCount} dataset${compCount !== 1 ? 's' : ''} scored</div>
      </div>
    `;

    // Coverage
    html += `
      <div class="kpi-card" data-dash-filter="coverage" data-dash-value="nationwide">
        <div class="kpi-card-accent" style="background: #4CAF50;"></div>
        <div class="kpi-value" style="color: #4CAF50;">${datasetsWithCoverage}</div>
        <div class="kpi-label">Coverage Analyzed</div>
        <div class="kpi-sublabel">${nationwideCoverage} nationwide · ${noCoverageData} pending</div>
      </div>
    `;

    html += `</div>`; // end kpi-row

    // ── Charts Row ──
    html += `<div class="dashboard-charts-row">`;

    // 1) Development Stage bar chart
    const stageEntries = [
      { key: 'production', label: 'Production', color: 'rgba(16,185,129,0.7)' },
      { key: 'qa', label: 'QA / Testing', color: 'rgba(139,92,246,0.7)' },
      { key: 'in_development', label: 'In Development', color: 'rgba(245,158,11,0.7)' },
      { key: 'planned', label: 'Planned', color: 'rgba(107,114,128,0.7)' },
      { key: 'deprecated', label: 'Deprecated', color: 'rgba(239,68,68,0.7)' },
      { key: 'unknown', label: 'Unknown', color: 'rgba(255,255,255,0.15)' },
    ];
    const maxStage = Math.max(...stageEntries.map(e => stageCounts[e.key] || 0), 1);

    html += `<div class="dashboard-chart-card">`;
    html += `<div class="dashboard-chart-title">Development Stage</div>`;
    html += `<div class="hbar-chart">`;
    stageEntries.forEach(e => {
      const count = stageCounts[e.key] || 0;
      if (count === 0 && e.key === 'unknown') return;
      const pct = (count / maxStage) * 100;
      html += `
        <div class="hbar-row" data-dash-filter="stage" data-dash-value="${e.key}">
          <span class="hbar-label">${e.label}</span>
          <div class="hbar-track">
            <div class="hbar-fill" style="width:${pct.toFixed(1)}%; background:${e.color};"></div>
          </div>
          <span class="hbar-count">${count}</span>
        </div>
      `;
    });
    html += `</div></div>`;

    // 2) Quality Tier donut chart
    const tierEntries = [
      { key: 'gold', label: 'Gold', color: '#fde047' },
      { key: 'silver', label: 'Silver', color: '#d4d4d4' },
      { key: 'bronze', label: 'Bronze', color: '#d4a574' },
      { key: 'unassigned', label: 'Unassigned', color: 'rgba(255,255,255,0.15)' },
    ];
    const tierTotal = tierEntries.reduce((s, e) => s + (tierCounts[e.key] || 0), 0) || 1;
    const circumference = 2 * Math.PI * 15.9155;

    html += `<div class="dashboard-chart-card">`;
    html += `<div class="dashboard-chart-title">Quality Tier</div>`;
    html += `<div class="donut-chart-container">`;
    html += `<svg class="donut-svg" viewBox="0 0 42 42">`;
    html += `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="3.5"/>`;

    let tierOffset = 0;
    tierEntries.forEach(e => {
      const count = tierCounts[e.key] || 0;
      if (count === 0) return;
      const pct = count / tierTotal;
      const dashLen = pct * circumference;
      const dashGap = circumference - dashLen;
      html += `<circle class="donut-segment" cx="21" cy="21" r="15.9155" fill="none" stroke="${e.color}" stroke-width="3.5" stroke-dasharray="${dashLen.toFixed(2)} ${dashGap.toFixed(2)}" stroke-dashoffset="${(-tierOffset).toFixed(2)}" transform="rotate(-90 21 21)"/>`;
      tierOffset += dashLen;
    });

    html += `</svg>`;

    html += `<div class="donut-legend">`;
    tierEntries.forEach(e => {
      const count = tierCounts[e.key] || 0;
      html += `<div class="donut-legend-item" data-dash-filter="tier" data-dash-value="${e.key}"><span class="donut-legend-swatch" style="background:${e.color}"></span>${e.label}<span class="donut-legend-count">${count}</span></div>`;
    });
    html += `</div></div></div>`;

    // 3) Geometry Types bar chart
    const geomEntries = Object.entries(geomCounts).sort((a, b) => b[1] - a[1]);
    const maxGeom = Math.max(...geomEntries.map(e => e[1]), 1);
    const geomColors = {
      'POINT': 'rgba(52,211,153,0.7)',
      'POLYGON': 'rgba(91,163,245,0.7)',
      'POLYLINE': 'rgba(16,185,129,0.7)',
      'TABLE': 'rgba(251,191,36,0.7)',
      'MULTIPOINT': 'rgba(52,211,153,0.5)',
      'MULTIPATCH': 'rgba(192,132,252,0.7)',
    };

    html += `<div class="dashboard-chart-card">`;
    html += `<div class="dashboard-chart-title">Geometry Types</div>`;
    html += `<div class="hbar-chart">`;
    geomEntries.forEach(([geom, count]) => {
      const pct = (count / maxGeom) * 100;
      const color = geomColors[geom] || 'rgba(255,255,255,0.2)';
      html += `
        <div class="hbar-row" data-dash-filter="geometry" data-dash-value="${escapeHtml(geom)}">
          <span class="hbar-label">${escapeHtml(geom)}</span>
          <div class="hbar-track">
            <div class="hbar-fill" style="width:${pct.toFixed(1)}%; background:${color};"></div>
          </div>
          <span class="hbar-count">${count}</span>
        </div>
      `;
    });
    html += `</div></div>`;

    html += `</div>`; // end charts-row

    // ── Tables Row ──
    html += `<div class="dashboard-table-row">`;

    // 1) Datasets needing attention (lowest completeness)
    html += `<div class="dashboard-table-card">`;
    html += `<div class="dashboard-chart-title">Needs Attention — Lowest Completeness</div>`;
    if (lowCompleteness.length) {
      html += `<table class="dashboard-mini-table"><thead><tr><th>Dataset</th><th>Stage</th><th>Tier</th><th>Complete</th></tr></thead><tbody>`;
      lowCompleteness.forEach(d => {
        const comp = d.maturity.completeness;
        const stage = d.development_stage || 'unknown';
        const tier = (d.maturity && d.maturity.quality_tier) || '';
        const stageClass = { planned: 'planned', in_development: 'dev', qa: 'qa', production: 'prod', deprecated: 'deprecated' }[stage] || 'planned';
        const tierClass = tier || 'bronze';
        const label = d._layer_name || d.title || d.id;
        html += `<tr>
          <td><button type="button" class="dash-link" data-dash-ds="${escapeHtml(d.id)}" title="${escapeHtml(d.title || d.id)}">${escapeHtml(label.length > 40 ? label.slice(0, 37) + '…' : label)}</button></td>
          <td><span class="dash-stage dash-stage-${stageClass}">${escapeHtml(stage.replace('_', ' '))}</span></td>
          <td>${tier ? `<span class="dash-tier dash-tier-${tierClass}">${escapeHtml(tier)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td>
            <div style="display:flex;align-items:center;gap:0.4rem;">
              <div style="flex:1;height:6px;background:rgba(255,255,255,0.04);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${comp}%;background:${comp < 50 ? 'var(--red)' : comp < 80 ? 'var(--amber)' : 'var(--green)'};border-radius:3px;"></div></div>
              <span style="font-size:0.78rem;font-weight:600;color:${comp < 50 ? 'var(--red)' : comp < 80 ? 'var(--amber)' : 'var(--green)'}">${comp}%</span>
            </div>
          </td>
        </tr>`;
      });
      html += `</tbody></table>`;
    } else {
      html += `<p style="color:var(--text-muted);font-size:0.85rem;">No completeness data available yet.</p>`;
    }
    html += `</div>`;

    // 2) Coverage gaps (nationwide datasets with fewest states)
    html += `<div class="dashboard-table-card">`;
    html += `<div class="dashboard-chart-title">Coverage Gaps — Nationwide Datasets</div>`;
    if (coverageGaps.length) {
      html += `<table class="dashboard-mini-table"><thead><tr><th>Dataset</th><th>States</th><th>Coverage</th></tr></thead><tbody>`;
      coverageGaps.forEach(d => {
        const stateData = d._coverage.states || {};
        const statesWithData = d._statesWithData;
        const totalStates = Object.keys(stateData).length || 51;
        const label = d._layer_name || d.title || d.id;

        // Mini coverage bar (51 tiny segments)
        const sortedStates = Object.entries(stateData).sort((a, b) => a[0].localeCompare(b[0]));
        let covBarHtml = '<div class="coverage-gap-bar" title="' + statesWithData + ' of ' + totalStates + ' states">';
        sortedStates.forEach(([abbr, count]) => {
          const color = count > 0 ? 'rgba(91,163,245,0.7)' : 'rgba(255,255,255,0.08)';
          covBarHtml += `<div class="coverage-gap-segment" style="background:${color};" title="${abbr}: ${count}"></div>`;
        });
        covBarHtml += '</div>';

        html += `<tr>
          <td><button type="button" class="dash-link" data-dash-ds="${escapeHtml(d.id)}" title="${escapeHtml(d.title || d.id)}">${escapeHtml(label.length > 35 ? label.slice(0, 32) + '…' : label)}</button></td>
          <td style="font-weight:600;color:${statesWithData < 30 ? 'var(--red)' : statesWithData < 45 ? 'var(--amber)' : 'var(--green)'}">${statesWithData}/${totalStates}</td>
          <td style="min-width:120px;">${covBarHtml}</td>
        </tr>`;
      });
      html += `</tbody></table>`;
    } else {
      html += `<p style="color:var(--text-muted);font-size:0.85rem;">No nationwide datasets with coverage data yet.</p>`;
    }
    html += `</div>`;

    html += `</div>`; // end table-row

    // ── Service Health Status (async) ──
    html += `
      <div class="dashboard-charts-row" style="grid-template-columns: 1fr;">
        <div class="dashboard-chart-card" id="dashServiceHealthCard">
          <div class="dashboard-chart-title">Service Health</div>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:0.5rem;">Live reachability check of all cataloged web service endpoints.</p>
          <div data-dash-health-summary class="service-health-summary"></div>
          <div data-dash-health-list>
            <p class="loading-message" style="font-size:0.85rem;">Checking services\u2026</p>
          </div>
        </div>
      </div>
    `;

    // ── Pending Dataset Requests (loads async) ──
    html += `
      <div class="dashboard-charts-row" style="grid-template-columns: 1fr;">
        <div class="dashboard-chart-card" id="dashPendingRequestsCard">
          <div class="dashboard-chart-title">Pending Dataset Requests</div>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:0.5rem;">Open requests awaiting review from the community.</p>
          <div data-dash-pending-list>
            <p class="loading-message" style="font-size:0.85rem;">Loading&hellip;</p>
          </div>
        </div>
      </div>
    `;

    // ── Office / Owner breakdown ──
    const officeEntries = Object.entries(officeCounts).sort((a, b) => b[1] - a[1]);
    const maxOffice = Math.max(...officeEntries.map(e => e[1]), 1);

    html += `<div class="dashboard-charts-row" style="grid-template-columns: 1fr;">`;
    html += `<div class="dashboard-chart-card">`;
    html += `<div class="dashboard-chart-title">Datasets by Office Owner</div>`;
    html += `<div class="hbar-chart">`;
    officeEntries.forEach(([office, count]) => {
      const pct = (count / maxOffice) * 100;
      html += `
        <div class="hbar-row" data-dash-filter="office" data-dash-value="${escapeHtml(office)}">
          <span class="hbar-label">${escapeHtml(office)}</span>
          <div class="hbar-track">
            <div class="hbar-fill" style="width:${pct.toFixed(1)}%; background:rgba(192,132,252,0.6);"></div>
          </div>
          <span class="hbar-count">${count}</span>
        </div>
      `;
    });
    html += `</div></div></div>`;

    els.dashboardContentEl.innerHTML = html;

    // ── Wire up dataset links in dashboard tables ──
    els.dashboardContentEl.querySelectorAll('button[data-dash-ds]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dsId = btn.getAttribute('data-dash-ds');
        showDatasetsView();
        state.lastSelectedDatasetId = dsId;
        if (_renderDatasetDetail) _renderDatasetDetail(dsId);
      });
    });

    // ── Wire up drill-down filter clicks ──
    els.dashboardContentEl.querySelectorAll('[data-dash-filter]').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        // Don't intercept clicks on nested dash-ds buttons
        if (e.target.closest('button[data-dash-ds]')) return;
        const group = el.getAttribute('data-dash-filter');
        const value = el.getAttribute('data-dash-value');
        applyDashboardFilter(group, value);
      });
    });

    // ── Load pending requests async ──
    loadDashboardPendingRequests();

    // ── Load service health checks async ──
    loadServiceHealthStatus();
  }

/** Fetch and render pending dataset requests in the dashboard. */
async function loadDashboardPendingRequests() {
  const listEl = els.dashboardContentEl?.querySelector('[data-dash-pending-list]');
  if (!listEl) return;

  try {
    const requests = await fetchPendingDatasetRequests();

    if (!requests || !requests.length) {
      listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No pending requests. The community hasn\'t submitted any new dataset requests yet.</p>';
      return;
    }

    let html = `<div class="pending-requests-dashboard">`;
    html += `<p style="margin-bottom:0.5rem;font-size:0.85rem;"><strong>${requests.length}</strong> pending request${requests.length !== 1 ? 's' : ''}</p>`;
    html += `<ul class="pending-requests-list">`;
    requests.forEach(req => {
      const name = parseRequestedDatasetName(req.title);
      const desc = parseRequestedDescription(req.body);
      const date = req.created_at ? new Date(req.created_at).toLocaleDateString() : '';
      const user = req.user || '';
      html += `
        <li class="pending-request-item">
          <a href="${escapeHtml(req.url)}" target="_blank" rel="noopener" class="pending-request-link">
            <strong>${escapeHtml(name)}</strong>
            ${desc ? `<span class="pending-request-desc">${escapeHtml(desc)}</span>` : ''}
            <span class="pending-request-meta">${user ? `by ${escapeHtml(user)}` : ''}${user && date ? ` \u00b7 ` : ''}${date || ''}</span>
          </a>
        </li>
      `;
    });
    html += `</ul></div>`;
    listEl.innerHTML = html;
  } catch (err) {
    console.warn('Failed to load pending requests for dashboard', err);
    listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Could not load pending requests.</p>';
  }
}

/** Check all unique service URLs and display results in the dashboard. */
async function loadServiceHealthStatus() {
  const summaryEl = els.dashboardContentEl?.querySelector('[data-dash-health-summary]');
  const listEl = els.dashboardContentEl?.querySelector('[data-dash-health-list]');
  if (!listEl) return;

  const ds = state.allDatasets;

  // Build unique service URL map: url → { url, datasets: [{ id, title }] }
  const serviceMap = new Map();
  ds.forEach(d => {
    const url = d.public_web_service;
    if (!url) return;
    // Use the parent service URL if available, otherwise the dataset URL directly
    const key = d._parent_service || url;
    if (!serviceMap.has(key)) {
      serviceMap.set(key, { url: key, datasets: [] });
    }
    serviceMap.get(key).datasets.push({ id: d.id, title: d._layer_name || d.title || d.id });
  });

  const services = [...serviceMap.values()];
  if (!services.length) {
    listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No web services configured in the catalog.</p>';
    if (summaryEl) summaryEl.innerHTML = '';
    return;
  }

  // Show progress bar
  let checked = 0;
  const total = services.length;
  function updateProgress() {
    if (!summaryEl) return;
    summaryEl.innerHTML = `
      <div class="health-progress">
        <span class="health-progress-label">Checking ${checked} / ${total} services\u2026</span>
        <div class="completeness-bar-track" style="height:6px;">
          <div class="completeness-bar-fill" style="width:${Math.round((checked / total) * 100)}%;background:var(--accent);transition:width 300ms;"></div>
        </div>
      </div>
    `;
  }
  updateProgress();

  // Check all services with concurrency limit
  const CONCURRENCY = 4;
  const results = new Array(services.length);
  let idx = 0;

  async function worker() {
    while (idx < services.length) {
      const i = idx++;
      const svc = services[i];
      // Use the raw service URL — checkUrlStatusDetailed handles ArcGIS REST query internally
      const result = await checkUrlStatusDetailed(svc.url);
      results[i] = { ...svc, status: result.status, detail: result.detail || '' };
      checked++;
      updateProgress();
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Tally
  let okCount = 0, badCount = 0, unknownCount = 0;
  results.forEach(r => {
    if (r.status === 'ok') okCount++;
    else if (r.status === 'bad') badCount++;
    else unknownCount++;
  });

  // Summary badges
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="health-kpi-row">
        <span class="health-kpi health-kpi-ok"><span class="health-kpi-value">${okCount}</span> Serving Data</span>
        <span class="health-kpi health-kpi-bad"><span class="health-kpi-value">${badCount}</span> Not Serving</span>
        <span class="health-kpi health-kpi-unknown"><span class="health-kpi-value">${unknownCount}</span> Uncertain</span>
        <span class="health-kpi" style="color:var(--text-muted);"><span class="health-kpi-value">${total}</span> Total</span>
      </div>
    `;
  }

  // Sort: bad first, then unknown, then ok
  const statusOrder = { bad: 0, unknown: 1, ok: 2 };
  results.sort((a, b) => (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1));

  // Table
  let html = '';
  html += `<table class="dashboard-mini-table service-health-table"><thead><tr><th>Status</th><th>Service Endpoint</th><th>Detail</th><th>Datasets</th></tr></thead><tbody>`;
  results.forEach(r => {
    const statusIcon = r.status === 'ok'
      ? '<span class="health-dot health-dot-ok" title="Serving data">\u25CF</span>'
      : r.status === 'bad'
        ? '<span class="health-dot health-dot-bad" title="Not serving data">\u25CF</span>'
        : '<span class="health-dot health-dot-unknown" title="Cannot verify">\u25CF</span>';
    const statusLabel = r.status === 'ok' ? 'Healthy' : r.status === 'bad' ? 'Down' : '???';
    const shortUrl = r.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const truncUrl = shortUrl.length > 60 ? shortUrl.slice(0, 57) + '\u2026' : shortUrl;
    const dsCount = r.datasets.length;
    const dsNames = r.datasets.slice(0, 3).map(d => escapeHtml(d.title)).join(', ');
    const more = dsCount > 3 ? ` +${dsCount - 3} more` : '';
    const detailText = r.detail ? escapeHtml(r.detail) : '';

    html += `<tr class="health-row health-row-${r.status}">`;
    html += `<td class="health-status-cell">${statusIcon} ${statusLabel}</td>`;
    html += `<td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="health-url" title="${escapeHtml(r.url)}">${escapeHtml(truncUrl)}</a></td>`;
    html += `<td class="health-detail-cell" style="font-size:0.8rem;color:var(--text-muted);max-width:220px;">${detailText}</td>`;
    html += `<td class="health-ds-cell">${dsNames}${more}</td>`;
    html += `</tr>`;
  });
  html += `</tbody></table>`;

  listEl.innerHTML = html;

  // Wire dataset links in health table
  listEl.querySelectorAll('button[data-dash-ds]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dsId = btn.getAttribute('data-dash-ds');
      showDatasetsView();
      state.lastSelectedDatasetId = dsId;
      if (_renderDatasetDetail) _renderDatasetDetail(dsId);
    });
  });
}
