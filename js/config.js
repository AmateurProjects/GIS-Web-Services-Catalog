export const CATALOG_URL = 'data/catalog.json';
export const GITHUB_NEW_ISSUE_BASE = 'https://github.com/AmateurProjects/Public-Lands-Data-Catalog/issues/new';

// Cloudflare Worker base URL for freshness & health data (R2-backed).
// Set to '' to fall back to local data/ files and live browser checks.
// Example: 'https://gis-freshness-worker.your-subdomain.workers.dev'
export const WORKER_BASE_URL = 'https://gis-freshness-worker.screening-app.workers.dev';
