// metadata-export.js — Generate DCAT-US, ISO 19115, and Schema.org/Dataset metadata exports.
//
// Provides per-dataset and bulk catalog export in three standard formats:
//   1. DCAT-US JSON-LD  (Data Catalog Vocabulary, US profile)
//   2. ISO 19115 XML    (simplified metadata record)
//   3. Schema.org/Dataset JSON-LD (for Google Dataset Search indexing)
//
// All exports are generated client-side from catalog.json data + service-info.

import { state } from './state.js';
import { escapeHtml } from './utils.js';

// ── DCAT-US JSON-LD ──

function buildDcatDistribution(dataset) {
  const distributions = [];
  if (dataset.public_web_service) {
    const isFeature = /FeatureServer/i.test(dataset.public_web_service);
    const isMap = /MapServer/i.test(dataset.public_web_service);
    distributions.push({
      '@type': 'dcat:Distribution',
      'dcat:accessURL': dataset.public_web_service,
      'dcat:mediaType': 'application/json',
      'dcterms:format': isFeature ? 'ArcGIS FeatureServer' : isMap ? 'ArcGIS MapServer' : 'ArcGIS REST Service',
      'dcterms:title': 'Public Web Service',
    });
  }
  if (dataset.internal_web_service) {
    distributions.push({
      '@type': 'dcat:Distribution',
      'dcat:accessURL': dataset.internal_web_service,
      'dcterms:title': 'Internal Web Service',
    });
  }
  return distributions;
}

function buildDcatDataset(dataset) {
  const record = {
    '@type': 'dcat:Dataset',
    'dcterms:identifier': dataset.id,
    'dcterms:title': dataset.title || dataset.id,
    'dcterms:description': dataset.description || '',
    'dcterms:publisher': {
      '@type': 'org:Organization',
      'org:name': dataset.agency_owner || 'Unknown',
      'org:subOrganizationOf': dataset.office_owner || '',
    },
    'dcat:contactPoint': {
      '@type': 'vcard:Contact',
      'vcard:hasEmail': dataset.contact_email ? `mailto:${dataset.contact_email}` : '',
    },
    'dcat:keyword': Array.isArray(dataset.topics) ? dataset.topics : [],
    'dcterms:accessRights': dataset.access_level || 'public',
    'dcterms:accrualPeriodicity': mapFrequency(dataset.update_frequency),
    'dcat:distribution': buildDcatDistribution(dataset),
  };

  if (dataset.geometry_type) {
    record['dcterms:spatial'] = dataset.geometry_type;
  }
  if (dataset.coverage) {
    record['dcterms:spatial_coverage'] = dataset.coverage;
  }
  if (dataset.data_standard) {
    record['dcterms:conformsTo'] = dataset.data_standard;
  }

  return record;
}

/**
 * Generate a full DCAT-US JSON-LD catalog from all datasets.
 */
export function generateDcatCatalog(datasets) {
  const ds = datasets || state.allDatasets || [];
  return {
    '@context': {
      'dcat': 'http://www.w3.org/ns/dcat#',
      'dcterms': 'http://purl.org/dc/terms/',
      'foaf': 'http://xmlns.com/foaf/0.1/',
      'org': 'http://www.w3.org/ns/org#',
      'vcard': 'http://www.w3.org/2006/vcard/ns#',
    },
    '@type': 'dcat:Catalog',
    'dcterms:title': 'BLM GIS Web Services Catalog',
    'dcterms:description': 'Catalog of Bureau of Land Management GIS web services and spatial datasets.',
    'dcterms:publisher': {
      '@type': 'org:Organization',
      'org:name': 'Bureau of Land Management',
    },
    'dcterms:issued': new Date().toISOString().split('T')[0],
    'dcat:dataset': ds.map(buildDcatDataset),
  };
}

/**
 * Generate DCAT-US JSON-LD for a single dataset.
 */
export function generateDcatDataset(dataset) {
  return {
    '@context': {
      'dcat': 'http://www.w3.org/ns/dcat#',
      'dcterms': 'http://purl.org/dc/terms/',
      'foaf': 'http://xmlns.com/foaf/0.1/',
      'org': 'http://www.w3.org/ns/org#',
      'vcard': 'http://www.w3.org/2006/vcard/ns#',
    },
    ...buildDcatDataset(dataset),
  };
}

// ── Schema.org/Dataset JSON-LD ──

/**
 * Generate Schema.org/Dataset JSON-LD (for Google Dataset Search).
 */
export function generateSchemaOrgDataset(dataset) {
  const record = {
    '@context': 'https://schema.org/',
    '@type': 'Dataset',
    'name': dataset.title || dataset.id,
    'description': dataset.description || '',
    'identifier': dataset.id,
    'creator': {
      '@type': 'Organization',
      'name': dataset.agency_owner || 'Bureau of Land Management',
    },
    'license': 'https://www.usa.gov/government-works',
    'isAccessibleForFree': true,
    'keywords': Array.isArray(dataset.topics) ? dataset.topics : [],
  };

  if (dataset.public_web_service) {
    record.distribution = [{
      '@type': 'DataDownload',
      'contentUrl': dataset.public_web_service,
      'encodingFormat': 'application/json',
      'name': 'ArcGIS REST Service',
    }];
  }

  if (dataset.coverage) {
    record.spatialCoverage = {
      '@type': 'Place',
      'name': dataset.coverage === 'nationwide' ? 'United States' : dataset.coverage,
    };
  }

  if (dataset.update_frequency) {
    record.temporalCoverage = dataset.update_frequency;
  }

  return record;
}

/**
 * Generate Schema.org/DataCatalog JSON-LD for the full catalog.
 */
export function generateSchemaOrgCatalog(datasets) {
  const ds = datasets || state.allDatasets || [];
  return {
    '@context': 'https://schema.org/',
    '@type': 'DataCatalog',
    'name': 'BLM GIS Web Services Catalog',
    'description': 'Catalog of Bureau of Land Management GIS web services and spatial datasets.',
    'provider': {
      '@type': 'Organization',
      'name': 'Bureau of Land Management',
    },
    'dataset': ds.map(generateSchemaOrgDataset),
  };
}

// ── ISO 19115 XML (simplified) ──

function xmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate a simplified ISO 19115-like XML metadata record for a dataset.
 */
export function generateIso19115(dataset) {
  const today = new Date().toISOString().split('T')[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<gmd:MD_Metadata
  xmlns:gmd="http://www.isotc211.org/2005/gmd"
  xmlns:gco="http://www.isotc211.org/2005/gco"
  xmlns:gml="http://www.opengis.net/gml/3.2">

  <gmd:fileIdentifier>
    <gco:CharacterString>${xmlEscape(dataset.id)}</gco:CharacterString>
  </gmd:fileIdentifier>

  <gmd:dateStamp>
    <gco:Date>${today}</gco:Date>
  </gmd:dateStamp>

  <gmd:identificationInfo>
    <gmd:MD_DataIdentification>

      <gmd:citation>
        <gmd:CI_Citation>
          <gmd:title>
            <gco:CharacterString>${xmlEscape(dataset.title || dataset.id)}</gco:CharacterString>
          </gmd:title>
        </gmd:CI_Citation>
      </gmd:citation>

      <gmd:abstract>
        <gco:CharacterString>${xmlEscape(dataset.description || '')}</gco:CharacterString>
      </gmd:abstract>

      <gmd:pointOfContact>
        <gmd:CI_ResponsibleParty>
          <gmd:organisationName>
            <gco:CharacterString>${xmlEscape(dataset.agency_owner || 'BLM')}</gco:CharacterString>
          </gmd:organisationName>
          <gmd:contactInfo>
            <gmd:CI_Contact>
              <gmd:address>
                <gmd:CI_Address>
                  <gmd:electronicMailAddress>
                    <gco:CharacterString>${xmlEscape(dataset.contact_email || '')}</gco:CharacterString>
                  </gmd:electronicMailAddress>
                </gmd:CI_Address>
              </gmd:address>
            </gmd:CI_Contact>
          </gmd:contactInfo>
          <gmd:role>
            <gmd:CI_RoleCode codeList="http://www.isotc211.org/2005/resources/Codelist/gmxCodelists.xml#CI_RoleCode" codeListValue="pointOfContact"/>
          </gmd:role>
        </gmd:CI_ResponsibleParty>
      </gmd:pointOfContact>

      <gmd:descriptiveKeywords>
        <gmd:MD_Keywords>
${(Array.isArray(dataset.topics) ? dataset.topics : []).map(t => `          <gmd:keyword><gco:CharacterString>${xmlEscape(t)}</gco:CharacterString></gmd:keyword>`).join('\n')}
        </gmd:MD_Keywords>
      </gmd:descriptiveKeywords>

      <gmd:spatialRepresentationType>
        <gmd:MD_SpatialRepresentationTypeCode codeList="http://www.isotc211.org/2005/resources/Codelist/gmxCodelists.xml#MD_SpatialRepresentationTypeCode" codeListValue="vector"/>
      </gmd:spatialRepresentationType>

    </gmd:MD_DataIdentification>
  </gmd:identificationInfo>

  <gmd:distributionInfo>
    <gmd:MD_Distribution>
      <gmd:transferOptions>
        <gmd:MD_DigitalTransferOptions>
          <gmd:onLine>
            <gmd:CI_OnlineResource>
              <gmd:linkage>
                <gmd:URL>${xmlEscape(dataset.public_web_service || '')}</gmd:URL>
              </gmd:linkage>
              <gmd:protocol>
                <gco:CharacterString>ArcGIS REST</gco:CharacterString>
              </gmd:protocol>
              <gmd:name>
                <gco:CharacterString>Public Web Service</gco:CharacterString>
              </gmd:name>
            </gmd:CI_OnlineResource>
          </gmd:onLine>
        </gmd:MD_DigitalTransferOptions>
      </gmd:transferOptions>
    </gmd:MD_Distribution>
  </gmd:distributionInfo>

</gmd:MD_Metadata>`;
}

// ── Utility ──

function mapFrequency(freq) {
  if (!freq) return '';
  const f = freq.toLowerCase();
  if (f.includes('daily')) return 'R/P1D';
  if (f.includes('weekly')) return 'R/P1W';
  if (f.includes('monthly')) return 'R/P1M';
  if (f.includes('quarterly')) return 'R/P3M';
  if (f.includes('annual') || f.includes('yearly')) return 'R/P1Y';
  if (f.includes('ad hoc') || f.includes('irregular')) return 'irregular';
  return freq;
}

// ── Download helpers ──

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download a single dataset's metadata in the given format.
 */
export function downloadDatasetMetadata(dataset, format = 'dcat') {
  switch (format) {
    case 'dcat': {
      const data = generateDcatDataset(dataset);
      downloadBlob(JSON.stringify(data, null, 2), `${dataset.id}_dcat.jsonld`, 'application/ld+json');
      break;
    }
    case 'schema': {
      const data = generateSchemaOrgDataset(dataset);
      downloadBlob(JSON.stringify(data, null, 2), `${dataset.id}_schema.jsonld`, 'application/ld+json');
      break;
    }
    case 'iso': {
      const xml = generateIso19115(dataset);
      downloadBlob(xml, `${dataset.id}_iso19115.xml`, 'application/xml');
      break;
    }
  }
}

/**
 * Download the full catalog in DCAT-US JSON-LD format.
 */
export function downloadCatalogDcat(datasets) {
  const data = generateDcatCatalog(datasets);
  downloadBlob(JSON.stringify(data, null, 2), 'catalog_dcat.jsonld', 'application/ld+json');
}

/**
 * Download the full catalog in Schema.org JSON-LD format.
 */
export function downloadCatalogSchemaOrg(datasets) {
  const data = generateSchemaOrgCatalog(datasets);
  downloadBlob(JSON.stringify(data, null, 2), 'catalog_schema.jsonld', 'application/ld+json');
}

/**
 * Render export buttons HTML for a dataset detail view.
 */
export function exportButtonsHTML(datasetId) {
  return `
    <div class="card card-export" style="border-left:4px solid var(--purple);">
      <div class="card-header-row"><h3>📤 Metadata Export</h3><span class="data-source-badge data-source-badge-auto">Auto</span></div>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:0.5rem;">Download machine-readable metadata for this dataset.</p>
      <div class="export-buttons-row">
        <button type="button" class="btn btn-export" data-export-format="dcat" data-export-ds="${escapeHtml(datasetId)}">
          DCAT-US JSON-LD
        </button>
        <button type="button" class="btn btn-export" data-export-format="schema" data-export-ds="${escapeHtml(datasetId)}">
          Schema.org JSON-LD
        </button>
        <button type="button" class="btn btn-export" data-export-format="iso" data-export-ds="${escapeHtml(datasetId)}">
          ISO 19115 XML
        </button>
      </div>
    </div>
  `;
}

/**
 * Wire export buttons inside a host element.
 * Call this after innerHTML is set in the detail view.
 */
export function wireExportButtons(hostEl) {
  hostEl.querySelectorAll('button[data-export-format]').forEach(btn => {
    btn.addEventListener('click', () => {
      const format = btn.getAttribute('data-export-format');
      const dsId = btn.getAttribute('data-export-ds');
      if (dsId === '__catalog__') {
        if (format === 'dcat') downloadCatalogDcat();
        else if (format === 'schema') downloadCatalogSchemaOrg();
        return;
      }
      const dataset = (state.allDatasets || []).find(d => d.id === dsId);
      if (dataset) downloadDatasetMetadata(dataset, format);
    });
  });
}
