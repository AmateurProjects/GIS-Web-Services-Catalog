import { GITHUB_NEW_ISSUE_BASE } from './config.js';

export function buildGithubIssueUrlForEditedDataset(datasetId, original, updated, changes) {
  const title = encodeURIComponent(`Dataset change request: ${datasetId}`);

  const bodyLines = [
    `## Suggested changes for dataset: \`${datasetId}\``,
    '',
    '### Summary of changes',
  ];

  if (!changes.length) {
    bodyLines.push('- No changes detected.');
  } else {
    changes.forEach((c) => {
      bodyLines.push(
        `- **${c.key}**: \`${JSON.stringify(c.from)}\` → \`${JSON.stringify(c.to)}\``
      );
    });
  }

  bodyLines.push(
    '',
    '---',
    '',
    '### Original dataset JSON',
    '```json',
    JSON.stringify(original, null, 2),
    '```',
    '',
    '### Updated dataset JSON',
    '```json',
    JSON.stringify(updated, null, 2),
    '```'
  );

  const body = encodeURIComponent(bodyLines.join('\n'));
  return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
}

export function buildGithubIssueUrlForNewDataset(datasetObj, newAttributes = []) {
  const titleBase = datasetObj.id || datasetObj.title || 'New dataset request';
  const title = encodeURIComponent(`New dataset request: ${titleBase}`);

  const bodyLines = [
    '## New dataset submission',
    '',
    'Please review the dataset proposal below. If approved, add it to `data/catalog.json` under `datasets`.',
    '',
    '### Review checklist',
    '- [ ] ID is unique and follows naming conventions',
    '- [ ] Title/description are clear',
    '- [ ] Owner/contact info is present',
    '- [ ] Geometry type is correct',
    '- [ ] Attribute IDs are valid (existing or proposed below)',
    '- [ ] Services/standards links are valid (if provided)',
    '',
    '---',
    '',
    '### Proposed dataset JSON',
    '```json',
    JSON.stringify(datasetObj, null, 2),
    '```',
  ];

  if (Array.isArray(newAttributes) && newAttributes.length) {
    bodyLines.push(
      '',
      '---',
      '',
      '### Proposed NEW attributes JSON (add under `attributes`)',
      '```json',
      JSON.stringify(newAttributes, null, 2),
      '```'
    );
  }

  const body = encodeURIComponent(bodyLines.join('\n'));
  return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
}

export function buildGithubIssueUrlForEditedAttribute(attrId, original, updated, changes) {
  const title = encodeURIComponent(`Attribute change request: ${attrId}`);

  const bodyLines = [
    `## Suggested changes for attribute: \`${attrId}\``,
    '',
    '### Summary of changes',
  ];

  if (!changes.length) {
    bodyLines.push('- No changes detected.');
  } else {
    changes.forEach((c) => {
      bodyLines.push(
        `- **${c.key}**: \`${JSON.stringify(c.from)}\` → \`${JSON.stringify(c.to)}\``
      );
    });
  }

  bodyLines.push(
    '',
    '---',
    '',
    '### Original attribute JSON',
    '```json',
    JSON.stringify(original, null, 2),
    '```',
    '',
    '### Updated attribute JSON',
    '```json',
    JSON.stringify(updated, null, 2),
    '```'
  );

  const body = encodeURIComponent(bodyLines.join('\n'));
  return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
}

export function buildGithubIssueUrlForNewAttributes(payload) {
  const title = encodeURIComponent(payload.title || 'New attribute(s) request');

  const bodyLines = [
    '## New attribute(s) submission',
    '',
    'Please review the attribute proposal below. If approved, add it to `data/catalog.json` under `attributes`.',
    '',
    '### Review checklist',
    '- [ ] ID(s) are unique and follow naming conventions',
    '- [ ] Type/definition are clear',
    '- [ ] Enumerations are complete (if applicable)',
    '',
    '---',
    '',
    '### Proposed attributes JSON',
    '```json',
    JSON.stringify(payload.attributes, null, 2),
    '```',
  ];

  if (payload.notes) {
    bodyLines.push('', '### Notes / context', payload.notes);
  }

  const body = encodeURIComponent(bodyLines.join('\n'));
  return `${GITHUB_NEW_ISSUE_BASE}?title=${title}&body=${body}`;
}
