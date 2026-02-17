// github-api.js — Fetch pending dataset requests from GitHub Issues (public API, no auth)

import { GITHUB_NEW_ISSUE_BASE } from './config.js';

// Derive owner/repo from the issue base URL
const _match = GITHUB_NEW_ISSUE_BASE.match(/github\.com\/([^/]+)\/([^/]+)\//);
const GITHUB_OWNER = _match ? _match[1] : '';
const GITHUB_REPO = _match ? _match[2] : '';
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

const REQUEST_LABEL = 'new-dataset-request';

/** Cache for pending requests (avoid re-fetching on every tab switch) */
let _pendingRequestsCache = null;
let _pendingRequestsCacheTs = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Fetch open GitHub issues labeled "new-dataset-request".
 * Uses the public GitHub API (no auth needed for public repos).
 * Returns an array of { title, body, url, created_at, user } objects.
 */
export async function fetchPendingDatasetRequests(forceRefresh = false) {
  // Return cached if fresh enough
  if (!forceRefresh && _pendingRequestsCache && (Date.now() - _pendingRequestsCacheTs < CACHE_TTL_MS)) {
    return _pendingRequestsCache;
  }

  if (!GITHUB_OWNER || !GITHUB_REPO) {
    console.warn('github-api: Could not derive owner/repo from GITHUB_NEW_ISSUE_BASE');
    return [];
  }

  try {
    // Fetch all open issues from the repo and filter client-side by title prefix.
    // We avoid the Search API because it doesn't follow GitHub repo renames,
    // while the regular Issues REST API does.
    const TITLE_PREFIX = 'New dataset request:';
    const allIssuesUrl = `${GITHUB_API_BASE}/issues?state=open&per_page=100&sort=created&direction=desc`;

    const resp = await fetch(allIssuesUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (!resp.ok) {
      console.warn(`github-api: GitHub API returned ${resp.status}`);
      return _pendingRequestsCache || [];
    }

    const allIssues = await resp.json();

    // Keep only issues whose title starts with our prefix OR that carry the label
    const issues = allIssues.filter(issue => {
      const title = (issue.title || '').trim();
      const hasPrefix = title.startsWith(TITLE_PREFIX);
      const hasLabel = Array.isArray(issue.labels) &&
        issue.labels.some(l => (l.name || '') === REQUEST_LABEL);
      return hasPrefix || hasLabel;
    });

    _pendingRequestsCache = issues.map(issue => ({
      title: issue.title || '',
      body: issue.body || '',
      url: issue.html_url || '',
      created_at: issue.created_at || '',
      user: issue.user?.login || '',
      number: issue.number,
    }));
    _pendingRequestsCacheTs = Date.now();
    return _pendingRequestsCache;
  } catch (err) {
    console.warn('github-api: Failed to fetch pending requests', err);
    return _pendingRequestsCache || [];
  }
}

/**
 * Build a pre-filled GitHub Issue URL for a new dataset request.
 * Minimal fields: name, description, justification.
 */
export function buildNewDatasetRequestUrl({ name, description, justification, properties = {} }) {
  const title = encodeURIComponent(`New dataset request: ${name || 'Untitled'}`);

  const bodyLines = [
    '## New Dataset Request',
    '',
    `**Dataset Name:** ${name || '(not provided)'}`,
    '',
    `**Description:** ${description || '(not provided)'}`,
    '',
    `**Justification / Use Case:** ${justification || '(not provided)'}`,
  ];

  // Add optional properties if any were filled in
  const propLabels = {
    topics: 'Topic Area',
    geometry_type: 'Data Type',
    coverage: 'Geographic Coverage',
    agency_owner: 'Data Owner / Manager',
    update_frequency: 'Update Frequency',
    access_level: 'Access Level',
    existing_link: 'Existing Link / Source',
    additional_notes: 'Additional Notes',
  };
  const filledProps = Object.entries(properties).filter(([, v]) => v);
  if (filledProps.length) {
    bodyLines.push('', '### Additional Details', '');
    filledProps.forEach(([key, val]) => {
      bodyLines.push(`**${propLabels[key] || key}:** ${val}`);
    });
  }

  bodyLines.push(
    '',
    '---',
    '',
    '*This request was submitted from the GIS Web Services Catalog.*',
  );

  const body = encodeURIComponent(bodyLines.join('\n'));
  const labels = encodeURIComponent(REQUEST_LABEL);
  return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}&labels=${labels}`;
}

/**
 * Extract the requested dataset name from a GitHub issue title.
 * Expected format: "New dataset request: <name>"
 */
export function parseRequestedDatasetName(issueTitle) {
  const prefix = 'New dataset request:';
  if (issueTitle.startsWith(prefix)) {
    return issueTitle.slice(prefix.length).trim();
  }
  return issueTitle;
}
