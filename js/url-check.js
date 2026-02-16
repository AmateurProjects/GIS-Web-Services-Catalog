// ====== URL STATUS CHECK HELPERS ======
export const URL_CHECK = {
  timeoutMs: 3500,
  concurrency: 3,
};

// Cache URL check results for this browser session (page lifetime)
// url -> { status: "ok"|"bad"|"unknown", ts: number }
const urlStatusCache = new Map();

export function getCachedUrlStatus(url) {
  if (!url) return null;
  return urlStatusCache.get(url) || null;
}

export function setCachedUrlStatus(url, status) {
  if (!url) return;
  urlStatusCache.set(url, { status, ts: Date.now() });
}

export function setUrlStatus(rowEl, status, titleText) {
  if (!rowEl) return;
  rowEl.setAttribute('data-url-status', status);
  const icon = rowEl.querySelector('.url-status-icon');
  if (icon) icon.title = titleText || '';
}

// Tries to determine if a URL is reachable.
// Returns: "ok" | "bad" | "unknown"
export async function checkUrlStatus(url) {
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

export async function runUrlChecks(hostEl) {
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
