export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function compactObject(obj) {
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

export function parseCsvList(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function tryParseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    return { __parse_error__: e.message };
  }
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function computeChanges(original, updated) {
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

/**
 * Renders a compact "Cached · Generated <timestamp>" badge.
 * @param {string|null} isoTimestamp — ISO timestamp string, or null
 * @returns {string} HTML string for the badge
 */
export function cacheBadgeHTML(isoTimestamp) {
  if (!isoTimestamp) return '';
  const d = new Date(isoTimestamp);
  const formatted = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<span class="cache-badge" title="Data loaded from cache generated on ${escapeHtml(formatted)}">📦 Cached · ${escapeHtml(formatted)}</span>`;
}
