// filters.js — Faceted filter state, panel rendering, and dashboard drill-down

import { state, els } from './state.js';
import { escapeHtml } from './utils.js';
import { showDatasetsView } from './navigation.js';

// ── Filter state ──
// Each key maps to a Set of selected values. Empty set = no filter.
export const activeFilters = {
  stage: new Set(),
  tier: new Set(),
  geometry: new Set(),
  coverage: new Set(),
  office: new Set(),
};

// Track which filter groups are expanded (persist across re-renders)
export const filterGroupOpen = { stage: true, tier: false, geometry: false, coverage: false, office: false };

// Lazy reference to renderDatasetList — set by app.js to avoid circular import at eval time
let _renderDatasetList = null;

export function registerFilterCallbacks({ renderDatasetList }) {
  _renderDatasetList = renderDatasetList;
}

export function getFilteredDatasets(textFilter) {
  const ft = (textFilter || '').trim().toLowerCase();
  let filtered = state.allDatasets;

  // Text search
  if (ft) {
    filtered = filtered.filter((ds) => {
      const haystack = [ds.id, ds.title, ds.description, ds.agency_owner, ds.office_owner, ...(ds.topics || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(ft);
    });
  }

  // Facet filters
  if (activeFilters.stage.size) {
    filtered = filtered.filter(ds => activeFilters.stage.has(ds.development_stage || 'unknown'));
  }
  if (activeFilters.tier.size) {
    filtered = filtered.filter(ds => {
      const t = (ds.maturity && ds.maturity.quality_tier) || 'unassigned';
      return activeFilters.tier.has(t);
    });
  }
  if (activeFilters.geometry.size) {
    filtered = filtered.filter(ds => activeFilters.geometry.has((ds.geometry_type || 'UNKNOWN').toUpperCase()));
  }
  if (activeFilters.coverage.size) {
    filtered = filtered.filter(ds => activeFilters.coverage.has(ds.coverage || 'unknown'));
  }
  if (activeFilters.office.size) {
    filtered = filtered.filter(ds => activeFilters.office.has(ds.office_owner || 'Unknown'));
  }

  return filtered;
}

export function hasAnyFilter() {
  return Object.values(activeFilters).some(s => s.size > 0);
}

export function clearAllFilters() {
  Object.values(activeFilters).forEach(s => s.clear());
  if (els.datasetSearchInput) els.datasetSearchInput.value = '';
  renderFilterPanel();
  if (_renderDatasetList) _renderDatasetList();
}

export function applyDashboardFilter(group, value) {
  // Clear all other filters, set only this one, then switch to Datasets tab
  Object.values(activeFilters).forEach(s => s.clear());
  if (els.datasetSearchInput) els.datasetSearchInput.value = '';
  activeFilters[group].add(value);
  filterGroupOpen[group] = true;
  showDatasetsView();
  renderFilterPanel();
  if (_renderDatasetList) _renderDatasetList();
}

// ── Filter Panel Renderer ──
export function renderFilterPanel() {
  if (!els.datasetFiltersEl || !els.activeFilterChipsEl) return;

  const FILTER_GROUPS = [
    {
      key: 'stage',
      label: 'Development Stage',
      options: [
        { value: 'production', label: 'Production' },
        { value: 'qa', label: 'QA / Testing' },
        { value: 'in_development', label: 'In Development' },
        { value: 'planned', label: 'Planned' },
        { value: 'deprecated', label: 'Deprecated' },
        { value: 'unknown', label: 'Unknown' },
      ],
      getValue: ds => ds.development_stage || 'unknown',
    },
    {
      key: 'tier',
      label: 'Quality Tier',
      options: [
        { value: 'gold', label: 'Gold' },
        { value: 'silver', label: 'Silver' },
        { value: 'bronze', label: 'Bronze' },
        { value: 'unassigned', label: 'Unassigned' },
      ],
      getValue: ds => (ds.maturity && ds.maturity.quality_tier) || 'unassigned',
    },
    {
      key: 'geometry',
      label: 'Geometry Type',
      options: null, // dynamic
      getValue: ds => (ds.geometry_type || 'UNKNOWN').toUpperCase(),
    },
    {
      key: 'coverage',
      label: 'Coverage',
      options: [
        { value: 'nationwide', label: 'Nationwide' },
        { value: 'multi_state', label: 'Multi-State' },
        { value: 'single_state', label: 'Single State' },
        { value: 'partial', label: 'Partial' },
        { value: 'unknown', label: 'Unknown' },
      ],
      getValue: ds => ds.coverage || 'unknown',
    },
    {
      key: 'office',
      label: 'Office Owner',
      options: null, // dynamic
      getValue: ds => ds.office_owner || 'Unknown',
    },
  ];

  // Pre-count values across ALL datasets (unfiltered) for facet counts
  const facetCounts = {};
  FILTER_GROUPS.forEach(fg => {
    facetCounts[fg.key] = {};
    state.allDatasets.forEach(ds => {
      const v = fg.getValue(ds);
      facetCounts[fg.key][v] = (facetCounts[fg.key][v] || 0) + 1;
    });
  });

  // Build dynamic options for geometry and office
  FILTER_GROUPS.forEach(fg => {
    if (fg.options === null) {
      const sorted = Object.entries(facetCounts[fg.key]).sort((a, b) => b[1] - a[1]);
      fg.options = sorted.map(([value]) => ({ value, label: value }));
    }
  });

  let panelHtml = '';
  FILTER_GROUPS.forEach(fg => {
    const active = activeFilters[fg.key];
    const activeCount = active.size;
    const isOpen = filterGroupOpen[fg.key];

    panelHtml += `<div class="filter-group">`;
    panelHtml += `<button type="button" class="filter-group-header${isOpen ? ' is-open' : ''}" data-fg-toggle="${fg.key}">`;
    panelHtml += `<span class="filter-group-toggle">▶</span>`;
    panelHtml += `<span class="filter-group-label">${escapeHtml(fg.label)}</span>`;
    if (activeCount > 0) {
      panelHtml += `<span class="filter-group-active-count">${activeCount}</span>`;
    }
    panelHtml += `</button>`;
    panelHtml += `<div class="filter-group-body${isOpen ? ' is-open' : ''}">`;

    fg.options.forEach(opt => {
      const count = facetCounts[fg.key][opt.value] || 0;
      const isChecked = active.has(opt.value);
      const isZero = count === 0 && !isChecked;
      panelHtml += `
        <div class="filter-option${isChecked ? ' is-checked' : ''}${isZero ? ' is-zero' : ''}" data-fg="${fg.key}" data-fv="${escapeHtml(opt.value)}">
          <span class="filter-checkbox">${isChecked ? '✓' : ''}</span>
          <span class="filter-option-label">${escapeHtml(opt.label)}</span>
          <span class="filter-option-count">${count}</span>
        </div>
      `;
    });

    panelHtml += `</div></div>`;
  });

  els.datasetFiltersEl.innerHTML = panelHtml;

  // Wire filter group toggle
  els.datasetFiltersEl.querySelectorAll('[data-fg-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-fg-toggle');
      filterGroupOpen[key] = !filterGroupOpen[key];
      renderFilterPanel();
    });
  });

  // Wire filter option clicks
  els.datasetFiltersEl.querySelectorAll('.filter-option').forEach(el => {
    el.addEventListener('click', () => {
      const group = el.getAttribute('data-fg');
      const value = el.getAttribute('data-fv');
      if (activeFilters[group].has(value)) {
        activeFilters[group].delete(value);
      } else {
        activeFilters[group].add(value);
      }
      renderFilterPanel();
      if (_renderDatasetList) _renderDatasetList();
    });
  });

  // ── Active filter chips ──
  let chipsHtml = '';
  const chipLabels = {
    stage: 'Stage', tier: 'Tier', geometry: 'Geometry',
    coverage: 'Coverage', office: 'Office',
  };
  Object.entries(activeFilters).forEach(([group, values]) => {
    values.forEach(v => {
      const label = `${chipLabels[group]}: ${v}`;
      chipsHtml += `<span class="filter-chip">${escapeHtml(label)}<button type="button" class="filter-chip-remove" data-chip-fg="${group}" data-chip-fv="${escapeHtml(v)}">✕</button></span>`;
    });
  });
  if (hasAnyFilter()) {
    chipsHtml += `<button type="button" class="filter-clear-all" data-clear-all-filters>Clear all</button>`;
  }
  els.activeFilterChipsEl.innerHTML = chipsHtml;

  // Wire chip removal
  els.activeFilterChipsEl.querySelectorAll('.filter-chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = btn.getAttribute('data-chip-fg');
      const value = btn.getAttribute('data-chip-fv');
      activeFilters[group].delete(value);
      renderFilterPanel();
      if (_renderDatasetList) _renderDatasetList();
    });
  });

  // Wire clear all
  const clearBtn = els.activeFilterChipsEl.querySelector('[data-clear-all-filters]');
  if (clearBtn) clearBtn.addEventListener('click', clearAllFilters);
}
