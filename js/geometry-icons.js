// Return HTML snippet for a geometry-type icon.
// Follows ArcGIS Online / modern GIS catalog visual conventions.
// contextClass: "geom-icon-list" (sidebar) or "geom-icon-inline" (detail).
export function getGeometryIconHTML(geometryType, contextClass) {
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
