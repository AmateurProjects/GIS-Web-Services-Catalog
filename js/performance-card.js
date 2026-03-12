// ================================================================
// Performance Card — displays query benchmark results from Worker
// ================================================================
// Loads performance.json from the Worker (R2-backed) and renders
// a detail card with per-query response times and an overall grade.
// ================================================================

import { WORKER_BASE_URL } from './config.js';
import { escapeHtml } from './utils.js';

// ── Cache (loaded once from Worker R2) ──
let _perfCache = undefined; // undefined = not attempted

export async function loadPerformanceCache() {
  if (_perfCache !== undefined) return _perfCache;
  try {
    const workerBase = WORKER_BASE_URL ? WORKER_BASE_URL.replace(/\/+$/, '') : '';
    if (!workerBase) { _perfCache = null; return null; }
    const resp = await fetch(`${workerBase}/performance.json`);
    if (!resp.ok) { _perfCache = null; return null; }
    _perfCache = await resp.json();
    return _perfCache;
  } catch {
    _perfCache = null;
    return null;
  }
}

// ── Grading (mirrors Worker logic for client-side fallback) ──

const GRADE_META = {
  A: { label: 'Excellent', color: 'var(--green)',  icon: '🟢' },
  B: { label: 'Good',      color: 'var(--accent)', icon: '🔵' },
  C: { label: 'Fair',      color: 'var(--amber)',  icon: '🟡' },
  D: { label: 'Poor',      color: 'var(--red)',    icon: '🟠' },
  F: { label: 'Failing',   color: '#ef4444',       icon: '🔴' },
};

function gradeMeta(grade) {
  return GRADE_META[grade] || { label: grade || '—', color: 'var(--text-muted)', icon: '⚪' };
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Render ──

/**
 * Populate the performance card placeholder with benchmark data.
 * Called after the detail page HTML is set.
 */
export async function loadPerformanceCard(hostEl, dataset) {
  const contentEl = hostEl.querySelector('[data-perf-content]');
  const cardEl = hostEl.querySelector('#performanceCard');
  if (!contentEl) return;

  const perfData = await loadPerformanceCache();
  if (!perfData || !perfData.datasets) {
    contentEl.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);">No performance data available yet. Benchmark scans run automatically twice daily.</p>';
    hostEl.dispatchEvent(new CustomEvent('kpi:performance', { detail: { grade: '—', gradeLabel: 'No data', color: 'var(--text-muted)' } }));
    return;
  }

  const result = perfData.datasets.find(d => d.datasetId === dataset.id);
  if (!result) {
    contentEl.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);">No benchmark data for this dataset yet. It will be included in the next scheduled scan.</p>';
    hostEl.dispatchEvent(new CustomEvent('kpi:performance', { detail: { grade: '—', gradeLabel: 'Pending', color: 'var(--text-muted)' } }));
    return;
  }

  if (result.error) {
    contentEl.innerHTML = `<p style="font-size:0.85rem;color:var(--red);">Benchmark failed: ${escapeHtml(result.error)}</p>`;
    hostEl.dispatchEvent(new CustomEvent('kpi:performance', { detail: { grade: 'F', gradeLabel: 'Error', color: '#ef4444' } }));
    return;
  }

  const gm = gradeMeta(result.overall);

  // Dispatch KPI update
  hostEl.dispatchEvent(new CustomEvent('kpi:performance', { detail: { grade: result.overall, gradeLabel: gm.label, color: gm.color } }));

  // Set left-border color to match overall grade
  if (cardEl) cardEl.style.borderLeftColor = gm.color;

  let html = '';

  // Overall grade badge
  html += '<div class="perf-result">';
  html += `<div class="perf-overall-row">`;
  html += `<div class="perf-grade-badge" style="background:${gm.color};">${escapeHtml(result.overall)}</div>`;
  html += `<div class="perf-grade-info">`;
  html += `<div class="perf-grade-label">${escapeHtml(gm.label)} Performance</div>`;
  html += `<div class="perf-grade-desc">Overall grade based on ${result.metrics.length} standardized query benchmarks against industry baselines for enterprise GIS services.</div>`;
  html += `</div>`;
  html += `</div>`;

  // Metrics table
  if (result.metrics.length) {
    html += `<div class="perf-metrics-grid">`;
    for (const m of result.metrics) {
      const mg = gradeMeta(m.grade);
      const hasError = m.error && m.grade === 'F';
      html += `<div class="perf-metric-row">`;
      html += `<div class="perf-metric-name">${escapeHtml(m.label)}</div>`;
      html += `<div class="perf-metric-time${hasError ? ' perf-metric-error' : ''}">${hasError ? escapeHtml(m.error) : formatMs(m.responseMs)}</div>`;
      html += `<div class="perf-metric-grade" style="color:${mg.color};" title="${escapeHtml(mg.label)}">${m.grade || '—'}</div>`;
      html += `</div>`;
    }
    html += `</div>`;

    // Grade scale legend
    html += `<details class="perf-legend-details">`;
    html += `<summary>Grade scale</summary>`;
    html += `<div class="perf-legend">`;
    for (const [letter, meta] of Object.entries(GRADE_META)) {
      html += `<span class="perf-legend-item"><span style="color:${meta.color}; font-weight:700;">${letter}</span> ${meta.label}</span>`;
    }
    html += `</div>`;
    html += `<p class="perf-legend-note">Grades compare response times against standard baselines for government enterprise ArcGIS REST services measured from the Cloudflare edge. Individual user experience may differ based on network location.</p>`;
    html += `</details>`;
  }

  html += '</div>';

  contentEl.innerHTML = html;

  // Update subtitle with scan timestamp
  const subtitleEl = hostEl.querySelector('[data-perf-subtitle]');
  if (subtitleEl && perfData.generated) {
    const genDate = new Date(perfData.generated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    subtitleEl.textContent = `Standardized query benchmarks run from Cloudflare edge. Last scanned ${genDate}.`;
  }
}
