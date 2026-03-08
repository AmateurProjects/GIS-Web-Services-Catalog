// ===========================
// DASHBOARD RENDERER (ES Module)
// ===========================
import { state, els } from './state.js';
import { escapeHtml } from './utils.js';
import { showDatasetsView } from './navigation.js';
import { applyDashboardFilter } from './filters.js';
import { fetchPendingDatasetRequests, parseRequestedDatasetName, parseRequestedDescription } from './github-api.js';
import { checkUrlStatusDetailed } from './url-check.js';
import { formatFreshnessAge, freshnessColor, getConfidenceMeta } from './freshness.js';
import { getFreshnessIndex } from './detail.js';
import { downloadCatalogDcat, downloadCatalogSchemaOrg } from './metadata-export.js';
import { WORKER_BASE_URL } from './config.js';

let _renderDatasetDetail = null;
export function registerDashboardCallbacks({ renderDatasetDetail }) {
  _renderDatasetDetail = renderDatasetDetail;
}

export function renderDashboard() {
    if (!els.dashboardContentEl) return;

    const ds = state.allDatasets;
    const totalDatasets = ds.length;

    // ── Agency / Office breakdown ──
    // Group datasets by agency_owner, then by office_owner within each agency
    const agencyMap = {}; // { agency: { total, offices: { office: count } } }
    ds.forEach(d => {
      const agency = d.agency_owner || 'Unknown';
      const office = d.office_owner || '';
      if (!agencyMap[agency]) agencyMap[agency] = { total: 0, offices: {} };
      agencyMap[agency].total++;
      if (office) {
        agencyMap[agency].offices[office] = (agencyMap[agency].offices[office] || 0) + 1;
      }
    });

    // ── Build HTML ──
    let html = '';

    // Header
    html += `
      <div class="dashboard-header">
        <h2>Catalog Dashboard</h2>
        <p>${totalDatasets} datasets across ${Object.keys(agencyMap).length} agencies.</p>
        <div class="dashboard-export-row">
          <button type="button" class="btn btn-export btn-sm" data-dash-export="dcat">📤 Export DCAT-US</button>
          <button type="button" class="btn btn-export btn-sm" data-dash-export="schema">📤 Export Schema.org</button>
        </div>
      </div>
    `;

    // ── Service Health Status (async) ──
    html += `
      <div class="dashboard-charts-row" style="grid-template-columns: 1fr;">
        <div class="dashboard-chart-card" id="dashServiceHealthCard">
          <div class="dashboard-chart-title">Service Health</div>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:0.5rem;">Reachability check of all cataloged web service endpoints.</p>
          <div data-dash-health-summary class="service-health-summary"></div>
          <div data-dash-health-list>
            <p class="loading-message" style="font-size:0.85rem;">Loading health data\u2026</p>
          </div>
        </div>
      </div>
    `;

    // ── Data Freshness Overview (async) ──
    html += `
      <div class="dashboard-charts-row" style="grid-template-columns: 1fr;">
        <div class="dashboard-chart-card" id="dashFreshnessCard">
          <div class="dashboard-chart-title">🕐 Data Freshness</div>
          <p data-dash-freshness-subtitle style="color:var(--text-muted);font-size:0.85rem;margin-bottom:0.5rem;">Last-updated detection across all cataloged datasets (from pre-computed analysis).</p>
          <div data-dash-freshness-content>
            <p class="loading-message" style="font-size:0.85rem;">Loading freshness data&hellip;</p>
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

    // ── Datasets by Agency / Office ──
    const agencyColors = {
      'BLM': 'rgba(91,163,245,0.7)',
      'USGS': 'rgba(52,211,153,0.7)',
      'FEMA': 'rgba(245,158,11,0.7)',
      'USFWS': 'rgba(192,132,252,0.7)',
      'USFS': 'rgba(16,185,129,0.7)',
      'BIA': 'rgba(251,191,36,0.7)',
    };
    const agencyEntries = Object.entries(agencyMap).sort((a, b) => b[1].total - a[1].total);
    const maxAgency = Math.max(...agencyEntries.map(([, v]) => v.total), 1);

    html += `<div class="dashboard-charts-row" style="grid-template-columns: 1fr;">`;
    html += `<div class="dashboard-chart-card">`;
    html += `<div class="dashboard-chart-title">Datasets by Agency &amp; Office</div>`;
    html += `<div class="hbar-chart">`;
    agencyEntries.forEach(([agency, info]) => {
      const pct = (info.total / maxAgency) * 100;
      const color = agencyColors[agency] || 'rgba(255,255,255,0.25)';
      const officeKeys = Object.keys(info.offices);
      const hasOffices = officeKeys.length > 0;
      const agencyId = agency.replace(/[^a-zA-Z0-9]/g, '_');

      html += `
        <div class="hbar-row" data-dash-agency-row="${escapeHtml(agencyId)}" style="cursor:default;">
          <span class="hbar-label" style="font-weight:600;color:var(--text-main);">${escapeHtml(agency)}</span>
          <div class="hbar-track">
            <div class="hbar-fill" style="width:${pct.toFixed(1)}%; background:${color};"></div>
          </div>
          <span class="hbar-count">${info.total}</span>
          ${hasOffices ? `<button type="button" class="agency-toggle-btn" data-agency-toggle="${escapeHtml(agencyId)}" title="Show offices">▶</button>` : ''}
        </div>
      `;

      // Sub-rows for offices (collapsed by default)
      if (hasOffices) {
        const officeEntries = Object.entries(info.offices).sort((a, b) => b[1] - a[1]);
        const maxOffice = Math.max(...officeEntries.map(e => e[1]), 1);
        html += `<div class="agency-offices-group" data-agency-offices="${escapeHtml(agencyId)}" style="display:none;padding-left:1rem;">`;
        officeEntries.forEach(([office, count]) => {
          const oPct = (count / maxOffice) * 100;
          html += `
            <div class="hbar-row" data-dash-filter="office" data-dash-value="${escapeHtml(office)}" style="margin-bottom:0.15rem;">
              <span class="hbar-label" style="font-size:0.78rem;">${escapeHtml(office)}</span>
              <div class="hbar-track" style="height:16px;">
                <div class="hbar-fill" style="width:${oPct.toFixed(1)}%; background:${color}; opacity:0.6;"></div>
              </div>
              <span class="hbar-count" style="font-size:0.78rem;">${count}</span>
            </div>
          `;
        });
        // Datasets with no office_owner in this agency
        const unassignedCount = info.total - Object.values(info.offices).reduce((s, c) => s + c, 0);
        if (unassignedCount > 0) {
          const uPct = (unassignedCount / maxOffice) * 100;
          html += `
            <div class="hbar-row" style="margin-bottom:0.15rem;opacity:0.6;">
              <span class="hbar-label" style="font-size:0.78rem;font-style:italic;">No office assigned</span>
              <div class="hbar-track" style="height:16px;">
                <div class="hbar-fill" style="width:${uPct.toFixed(1)}%; background:rgba(255,255,255,0.15);"></div>
              </div>
              <span class="hbar-count" style="font-size:0.78rem;">${unassignedCount}</span>
            </div>
          `;
        }
        html += `</div>`;
      }
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

    // ── Wire agency toggle buttons ──
    els.dashboardContentEl.querySelectorAll('button[data-agency-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const agencyId = btn.getAttribute('data-agency-toggle');
        const group = els.dashboardContentEl.querySelector(`[data-agency-offices="${agencyId}"]`);
        if (!group) return;
        const isOpen = group.style.display !== 'none';
        group.style.display = isOpen ? 'none' : 'block';
        btn.textContent = isOpen ? '▶' : '▼';
      });
    });

    // ── Wire up catalog export buttons ──
    els.dashboardContentEl.querySelectorAll('button[data-dash-export]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fmt = btn.getAttribute('data-dash-export');
        if (fmt === 'dcat') downloadCatalogDcat();
        else if (fmt === 'schema') downloadCatalogSchemaOrg();
      });
    });

    // ── Load pending requests async ──
    loadDashboardPendingRequests();

    // ── Load service health checks async ──
    loadServiceHealthStatus();

    // ── Load freshness overview async ──
    loadDashboardFreshness();

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

/** Check all unique service URLs and display results in the dashboard.
 *  If Worker is configured, loads cached health.json from R2 first.
 *  Falls back to live browser-based checks. */
async function loadServiceHealthStatus() {
  const summaryEl = els.dashboardContentEl?.querySelector('[data-dash-health-summary]');
  const listEl = els.dashboardContentEl?.querySelector('[data-dash-health-list]');
  if (!listEl) return;

  const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
  const hasWorker = !!workerBase;

  // Try loading cached health from Worker (R2)
  let healthData = null;
  if (hasWorker) {
    try {
      const resp = await fetch(`${workerBase}/health.json`);
      if (resp.ok) healthData = await resp.json();
    } catch (_) {}
  }

  if (healthData && healthData.services && healthData.services.length > 0) {
    renderHealthResults(healthData.services, healthData, summaryEl, listEl, hasWorker);
    return;
  }

  // Fallback: live browser-based checks (original behaviour)
  runLiveHealthChecks(summaryEl, listEl, hasWorker);
}

/** Shared HTML renderer for health results (used by both cached & live paths). */
function renderHealthResults(results, meta, summaryEl, listEl, hasWorker) {
  // Tally
  let okCount = 0, badCount = 0, unknownCount = 0;
  results.forEach(r => {
    if (r.status === 'ok') okCount++;
    else if (r.status === 'bad') badCount++;
    else unknownCount++;
  });
  const total = results.length;

  // Summary badges + refresh button
  if (summaryEl) {
    let sumHtml = `
      <div class="health-kpi-row">
        <span class="health-kpi health-kpi-ok"><span class="health-kpi-value">${okCount}</span> Serving Data</span>
        <span class="health-kpi health-kpi-bad"><span class="health-kpi-value">${badCount}</span> Not Serving</span>
        <span class="health-kpi health-kpi-unknown"><span class="health-kpi-value">${unknownCount}</span> Uncertain</span>
        <span class="health-kpi" style="color:var(--text-muted);"><span class="health-kpi-value">${total}</span> Total</span>
      </div>`;
    sumHtml += `<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.35rem;flex-wrap:wrap;">`;
    if (meta?.generated) {
      const genDate = new Date(meta.generated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      sumHtml += `<span class="text-muted" style="font-size:0.82rem;">Generated ${escapeHtml(genDate)}</span>`;
    }
    if (hasWorker) {
      sumHtml += `<button type="button" class="btn btn-sm health-refresh-btn" title="Trigger a new health scan via the Worker">🔄 Refresh Health</button>`;
    }
    sumHtml += `</div>`;
    summaryEl.innerHTML = sumHtml;
    wireHealthRefreshBtn(summaryEl);
  }

  // Sort: bad first, then unknown, then ok
  const statusOrder = { bad: 0, unknown: 1, ok: 2 };
  const sorted = [...results].sort((a, b) => (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1));

  const problemResults = sorted.filter(r => r.status !== 'ok');
  const healthyResults = sorted.filter(r => r.status === 'ok');

  const tableHead = `<table class="dashboard-mini-table service-health-table"><thead><tr><th>Status</th><th>Service Endpoint</th><th>Detail</th><th>Datasets</th></tr></thead><tbody>`;
  const tableEnd = `</tbody></table>`;

  let html = '';
  if (problemResults.length) {
    html += tableHead;
    problemResults.forEach(r => { html += healthRow(r); });
    html += tableEnd;
  } else {
    html += `<p style="font-size:0.85rem;color:var(--green);font-weight:600;margin-bottom:0.5rem;">All services are healthy.</p>`;
  }

  if (healthyResults.length) {
    html += `<details class="healthy-services-details" style="margin-top:0.75rem;">`;
    html += `<summary style="cursor:pointer;font-size:0.85rem;color:var(--text-muted);user-select:none;">`;
    html += `<span class="health-dot health-dot-ok">\u25CF</span> ${healthyResults.length} healthy service${healthyResults.length !== 1 ? 's' : ''} \u2014 click to expand`;
    html += `</summary>`;
    html += tableHead;
    healthyResults.forEach(r => { html += healthRow(r); });
    html += tableEnd;
    html += `</details>`;
  }

  listEl.innerHTML = html;

  // Wire dataset links
  listEl.querySelectorAll('button[data-dash-ds]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dsId = btn.getAttribute('data-dash-ds');
      showDatasetsView();
      state.lastSelectedDatasetId = dsId;
      if (_renderDatasetDetail) _renderDatasetDetail(dsId);
    });
  });
}

/** Render a single health table row. */
function healthRow(r) {
  const statusIcon = r.status === 'ok'
    ? '<span class="health-dot health-dot-ok" title="Serving data">\u25CF</span>'
    : r.status === 'bad'
      ? '<span class="health-dot health-dot-bad" title="Not serving data">\u25CF</span>'
      : '<span class="health-dot health-dot-unknown" title="Cannot verify">\u25CF</span>';
  const statusLabel = r.status === 'ok' ? 'Healthy' : r.status === 'bad' ? 'Down' : '???';
  const shortUrl = r.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const truncUrl = shortUrl.length > 60 ? shortUrl.slice(0, 57) + '\u2026' : shortUrl;
  const dsCount = r.datasets ? r.datasets.length : 0;
  const dsLinks = r.datasets ? r.datasets.slice(0, 3).map(d =>
    `<button type="button" class="dash-link" data-dash-ds="${escapeHtml(d.id)}" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</button>`
  ).join(', ') : '';
  const more = dsCount > 3 ? ` +${dsCount - 3} more` : '';
  const detailText = r.detail ? escapeHtml(r.detail) : '';

  let row = `<tr class="health-row health-row-${r.status}">`;
  row += `<td class="health-status-cell">${statusIcon} ${statusLabel}</td>`;
  row += `<td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="health-url" title="${escapeHtml(r.url)}">${escapeHtml(truncUrl)}</a></td>`;
  row += `<td class="health-detail-cell" style="font-size:0.8rem;color:var(--text-muted);max-width:220px;">${detailText}</td>`;
  row += `<td class="health-ds-cell">${dsLinks}${more}</td>`;
  row += `</tr>`;
  return row;
}

/** Live browser-based health checks (fallback when Worker is not configured). */
async function runLiveHealthChecks(summaryEl, listEl, hasWorker) {
  const ds = state.allDatasets;

  const serviceMap = new Map();
  ds.forEach(d => {
    const url = d.public_web_service;
    if (!url) return;
    const key = d._parent_service || url;
    if (!serviceMap.has(key)) serviceMap.set(key, { url: key, datasets: [] });
    serviceMap.get(key).datasets.push({ id: d.id, title: d._layer_name || d.title || d.id });
  });

  const services = [...serviceMap.values()];
  if (!services.length) {
    listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No web services configured in the catalog.</p>';
    if (summaryEl) summaryEl.innerHTML = '';
    return;
  }

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
      </div>`;
  }
  updateProgress();

  const LIVE_CONCURRENCY = 4;
  const results = new Array(services.length);
  let idx = 0;

  async function worker() {
    while (idx < services.length) {
      const i = idx++;
      const svc = services[i];
      const result = await checkUrlStatusDetailed(svc.url);
      results[i] = { ...svc, status: result.status, detail: result.detail || '' };
      checked++;
      updateProgress();
    }
  }

  await Promise.all(Array.from({ length: LIVE_CONCURRENCY }, worker));
  renderHealthResults(results, null, summaryEl, listEl, hasWorker);
}

// ── Persistent floating toast for refresh progress ──
let _toastEl = null;
function showRefreshToast(msg) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.id = 'refresh-toast';
    _toastEl.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;background:var(--card-bg,#1e293b);color:var(--text,#e2e8f0);padding:0.65rem 1.1rem;border-radius:8px;font-size:0.85rem;box-shadow:0 4px 16px rgba(0,0,0,0.4);display:flex;align-items:center;gap:0.5rem;transition:opacity 0.3s;border:1px solid var(--border,#334155);';
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = msg;
  _toastEl.style.opacity = '1';
  _toastEl.style.display = 'flex';
}
function hideRefreshToast() {
  if (_toastEl) {
    _toastEl.style.opacity = '0';
    setTimeout(() => { if (_toastEl) _toastEl.style.display = 'none'; }, 350);
  }
}

/** Wire the health refresh button — drives batch-and-chain from the browser. */
function wireHealthRefreshBtn(container) {
  const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
  container.querySelectorAll('.health-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!workerBase) return;
      btn.disabled = true;
      try {
        let offset = 0;
        let done = false;
        while (!done) {
          const msg = `⏳ Health scan: batch ${offset}…`;
          btn.textContent = msg;
          showRefreshToast(msg);
          const resp = await fetch(`${workerBase}/health/refresh?offset=${offset}`, { method: 'POST' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const progress = await resp.json();
          if (progress.error) throw new Error(progress.error);
          done = progress.done;
          if (!done) offset = progress.nextOffset;
        }
        btn.textContent = '✅ Complete!';
        showRefreshToast('✅ Health scan complete!');
        setTimeout(() => loadServiceHealthStatus(), 500);
        setTimeout(() => { btn.textContent = '🔄 Refresh Health'; btn.disabled = false; hideRefreshToast(); }, 2500);
      } catch (e) {
        console.warn('Health refresh failed:', e);
        btn.textContent = '❌ Failed';
        showRefreshToast('❌ Health scan failed');
        setTimeout(() => { btn.textContent = '🔄 Refresh Health'; btn.disabled = false; hideRefreshToast(); }, 2500);
      }
    });
  });
}

/** Wire the freshness action buttons (refresh via Worker OR copy CLI command). */
function wireFreshnessButtons(container) {
  const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
  // Refresh button — drives batch-and-chain from the browser
  container.querySelectorAll('.freshness-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!workerBase) return;
      btn.disabled = true;
      try {
        let offset = 0;
        let done = false;
        while (!done) {
          const msg = `⏳ Freshness scan: batch ${offset}…`;
          btn.textContent = msg;
          showRefreshToast(msg);
          const resp = await fetch(`${workerBase}/freshness/refresh?offset=${offset}`, { method: 'POST' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const progress = await resp.json();
          if (progress.error) throw new Error(progress.error);
          done = progress.done;
          if (!done) offset = progress.nextOffset;
        }
        btn.textContent = '✅ Complete!';
        showRefreshToast('✅ Freshness scan complete!');
        setTimeout(() => loadDashboardFreshness(), 500);
        setTimeout(() => { btn.textContent = '🔄 Refresh Freshness'; btn.disabled = false; hideRefreshToast(); }, 2500);
      } catch (e) {
        console.warn('Freshness refresh failed:', e);
        btn.textContent = '❌ Failed';
        showRefreshToast('❌ Freshness scan failed');
        setTimeout(() => { btn.textContent = '🔄 Refresh Freshness'; btn.disabled = false; hideRefreshToast(); }, 2500);
      }
    });
  });

}

/** Load pre-computed freshness data and render dashboard section. */
async function loadDashboardFreshness() {
  const contentEl = els.dashboardContentEl?.querySelector('[data-dash-freshness-content]');
  if (!contentEl) return;
  const subtitleEl = els.dashboardContentEl?.querySelector('[data-dash-freshness-subtitle]');

  // Try loading from Worker (R2) first, then fall back to local file
  let freshnessData = getFreshnessIndex();
  if (!freshnessData && WORKER_BASE_URL) {
    try {
      const resp = await fetch(`${WORKER_BASE_URL.replace(/\/+$/, '')}/freshness.json`);
      if (resp.ok) freshnessData = await resp.json();
    } catch (_) {}
  }
  if (!freshnessData) {
    try {
      const resp = await fetch('data/freshness.json');
      if (resp.ok) freshnessData = await resp.json();
    } catch (_) {}
  }

  // Build action buttons — show refresh if Worker is configured, always show copy
  const hasWorker = !!WORKER_BASE_URL;
  const refreshBtn = hasWorker
    ? `<button type="button" class="btn btn-sm freshness-refresh-btn" title="Trigger a fresh scan via the Worker">🔄 Refresh Freshness</button>`
    : '';

  if (!freshnessData || !freshnessData.datasets || freshnessData.datasets.length === 0) {
    contentEl.innerHTML = `
      <div style="color:var(--text-muted);font-size:0.85rem;">
        <p>No freshness data available.</p>
        <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem;">
          ${refreshBtn}
        </div>
      </div>`;
    wireFreshnessButtons(contentEl);
    return;
  }

  // Update subtitle with generated datestamp
  if (subtitleEl && freshnessData.generated) {
    const genStr = new Date(freshnessData.generated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    subtitleEl.textContent = `Last-updated detection across all cataloged datasets (scanned ${genStr}).`;
  }

  const results = freshnessData.datasets;
  const ds = state.allDatasets;

  // Stats
  const total = results.length;
  const withDate = results.filter(r => r.lastUpdated);
  const fresh90 = withDate.filter(r => (new Date() - new Date(r.lastUpdated)) < 90 * 24 * 3600000);
  const stale365 = withDate.filter(r => (new Date() - new Date(r.lastUpdated)) > 365 * 24 * 3600000);
  const confCounts = { high: 0, medium: 0, low: 0, none: 0 };
  results.forEach(r => confCounts[r.confidence] = (confCounts[r.confidence] || 0) + 1);

  let html = '';

  // KPI row
  html += `<div class="freshness-kpi-row">`;
  html += `<span class="freshness-kpi"><span class="freshness-kpi-value" style="color:var(--green);">${fresh90.length}</span> Fresh (&lt;90d)</span>`;
  html += `<span class="freshness-kpi"><span class="freshness-kpi-value" style="color:var(--red);">${stale365.length}</span> Stale (&gt;1y)</span>`;
  html += `<span class="freshness-kpi"><span class="freshness-kpi-value" style="color:var(--accent);">${withDate.length}</span> Detected</span>`;
  html += `<span class="freshness-kpi"><span class="freshness-kpi-value" style="color:var(--text-muted);">${total - withDate.length}</span> Unknown</span>`;
  html += `</div>`;

  // Confidence breakdown
  html += `<div class="freshness-conf-row" style="margin:0.5rem 0;">`;
  ['high', 'medium', 'low', 'none'].forEach(c => {
    const cm = getConfidenceMeta(c);
    html += `<span style="font-size:0.8rem;color:${cm.color};margin-right:1rem;">${cm.icon} ${cm.label}: ${confCounts[c] || 0}</span>`;
  });
  html += `</div>`;

  // Build combined table: stalest datasets first
  const allWithDates = withDate
    .sort((a, b) => new Date(a.lastUpdated) - new Date(b.lastUpdated))
    .map(r => {
      const dataset = ds.find(d => d.id === r.datasetId);
      return { ...r, dataset };
    });
  
  const stalestItems = allWithDates.slice(0, 10);
  const remainingItems = allWithDates.slice(10);

  const freshnessTableHead = `<table class="dashboard-mini-table freshness-table"><thead><tr><th>Dataset</th><th>Last Updated</th><th>Age</th><th>Signal</th><th>Confidence</th></tr></thead><tbody>`;
  const freshnessTableEnd = `</tbody></table>`;

  function freshnessRow(r) {
    const label = r.dataset?._layer_name || r.dataset?.title || r.datasetId;
    const truncLabel = label.length > 40 ? label.slice(0, 37) + '…' : label;
    const age = formatFreshnessAge(r.lastUpdated);
    const ageColor = freshnessColor(r.lastUpdated);
    const cm = getConfidenceMeta(r.confidence);
    const dateStr = r.lastUpdated ? new Date(r.lastUpdated).toLocaleDateString() : '—';

    let row = `<tr>`;
    row += `<td><button type="button" class="dash-link" data-dash-ds="${escapeHtml(r.datasetId)}" title="${escapeHtml(label)}">${escapeHtml(truncLabel)}</button></td>`;
    row += `<td style="font-size:0.82rem;">${dateStr}</td>`;
    row += `<td style="color:${ageColor};font-weight:600;">${escapeHtml(age)}</td>`;
    row += `<td style="font-size:0.8rem;">${escapeHtml(r.signal || '—')}</td>`;
    row += `<td><span style="color:${cm.color};">${cm.icon}</span> ${escapeHtml(cm.label)}</td>`;
    row += `</tr>`;
    return row;
  }

  if (stalestItems.length) {
    html += `<div class="freshness-table-label" style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted);">Stalest datasets (oldest first)</div>`;
    html += freshnessTableHead;
    stalestItems.forEach(r => { html += freshnessRow(r); });
    html += freshnessTableEnd;
  }

  // Expandable section for remaining datasets (more recent ones)
  if (remainingItems.length) {
    html += `<details class="freshness-remaining-details" style="margin-top:0.75rem;">`;
    html += `<summary style="cursor:pointer;font-size:0.85rem;color:var(--text-muted);user-select:none;">`;
    html += `<span style="color:var(--green);">●</span> ${remainingItems.length} more dataset${remainingItems.length !== 1 ? 's' : ''} — click to expand`;
    html += `</summary>`;
    html += freshnessTableHead;
    remainingItems.forEach(r => { html += freshnessRow(r); });
    html += freshnessTableEnd;
    html += `</details>`;
  }

  // Unknown freshness (no date detected)
  const unknownItems = results.filter(r => !r.lastUpdated).map(r => {
    const dataset = ds.find(d => d.id === r.datasetId);
    return { ...r, dataset };
  });

  if (unknownItems.length) {
    html += `<details class="freshness-unknown-details" style="margin-top:0.75rem;">`;
    html += `<summary style="cursor:pointer;font-size:0.85rem;color:var(--text-muted);user-select:none;">`;
    html += `<span style="color:var(--text-muted);">○</span> ${unknownItems.length} dataset${unknownItems.length !== 1 ? 's' : ''} with unknown freshness — click to expand`;
    html += `</summary>`;
    html += `<table class="dashboard-mini-table freshness-table"><thead><tr><th>Dataset</th><th>Signal</th><th>Details</th></tr></thead><tbody>`;
    unknownItems.forEach(r => {
      const label = r.dataset?._layer_name || r.dataset?.title || r.datasetId;
      const truncLabel = label.length > 40 ? label.slice(0, 37) + '…' : label;
      const details = r.details || '—';
      const truncDetails = details.length > 60 ? details.slice(0, 57) + '…' : details;
      html += `<tr>`;
      html += `<td><button type="button" class="dash-link" data-dash-ds="${escapeHtml(r.datasetId)}" title="${escapeHtml(label)}">${escapeHtml(truncLabel)}</button></td>`;
      html += `<td style="font-size:0.8rem;">${escapeHtml(r.signal || 'none')}</td>`;
      html += `<td style="font-size:0.8rem;color:var(--text-muted);" title="${escapeHtml(details)}">${escapeHtml(truncDetails)}</td>`;
      html += `</tr>`;
    });
    html += `</tbody></table>`;
    html += `</details>`;
  }

  const genDate = freshnessData.generated
    ? new Date(freshnessData.generated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  html += `<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;">`;
  if (genDate) html += `<span class="text-muted" style="font-size:0.82rem;">Generated ${escapeHtml(genDate)}</span>`;
  html += refreshBtn;
  html += `</div>`;

  contentEl.innerHTML = html;
  wireFreshnessButtons(contentEl);

  // Wire dataset links
  contentEl.querySelectorAll('button[data-dash-ds]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dsId = btn.getAttribute('data-dash-ds');
      showDatasetsView();
      state.lastSelectedDatasetId = dsId;
      if (_renderDatasetDetail) _renderDatasetDetail(dsId);
    });
  });
}
