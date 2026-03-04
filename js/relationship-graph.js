// relationship-graph.js — Dataset relationship visualization module.
//
// Discovers and visualizes three types of relationships:
//   1. Parent service → child layers (from _parent_service / _parent_dataset_id)
//   2. Shared fields between datasets (from service-info field data)
//   3. Topic clusters (datasets sharing the same topics)
//
// Renders as an interactive force-directed graph using SVG.

import { state, els } from './state.js';
import { escapeHtml } from './utils.js';

// ── Relationship Discovery ──

/**
 * Build relationship data from catalog datasets.
 * Returns { nodes: [], links: [], clusters: {} }
 */
export function buildRelationshipGraph(datasets) {
  const ds = datasets || state.allDatasets || [];
  const nodes = [];
  const links = [];
  const nodeMap = new Map(); // id → node index

  // Create nodes for each dataset
  ds.forEach((d, i) => {
    nodeMap.set(d.id, i);
    nodes.push({
      id: d.id,
      label: d._layer_name || d.title || d.id,
      type: 'dataset',
      group: d._parent_dataset_id || d.id,
      geometry: d.geometry_type || 'UNKNOWN',
      stage: d.development_stage || 'unknown',
      tier: d.maturity?.quality_tier || '',
      topics: Array.isArray(d.topics) ? d.topics : [],
      parentService: d._parent_service || null,
    });
  });

  // Link 1: Parent-child (shared _parent_dataset_id)
  const parentGroups = new Map();
  ds.forEach(d => {
    const parent = d._parent_dataset_id;
    if (parent) {
      if (!parentGroups.has(parent)) parentGroups.set(parent, []);
      parentGroups.get(parent).push(d.id);
    }
  });

  parentGroups.forEach((children, parentId) => {
    // Link each child to every other child in the same parent group
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const src = nodeMap.get(children[i]);
        const tgt = nodeMap.get(children[j]);
        if (src !== undefined && tgt !== undefined) {
          links.push({
            source: src,
            target: tgt,
            type: 'parent-child',
            label: `Same service: ${parentId}`,
            strength: 0.8,
          });
        }
      }
    }
  });

  // Link 2: Shared topics
  const topicIndex = new Map();
  ds.forEach(d => {
    (d.topics || []).forEach(t => {
      if (!topicIndex.has(t)) topicIndex.set(t, []);
      topicIndex.get(t).push(d.id);
    });
  });

  topicIndex.forEach((members, topic) => {
    if (members.length < 2 || members.length > 20) return; // skip overly common topics
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const src = nodeMap.get(members[i]);
        const tgt = nodeMap.get(members[j]);
        if (src !== undefined && tgt !== undefined) {
          // Check if link already exists
          const existing = links.find(l =>
            (l.source === src && l.target === tgt) || (l.source === tgt && l.target === src)
          );
          if (existing) {
            existing.sharedTopics = (existing.sharedTopics || 0) + 1;
            existing.strength = Math.min(existing.strength + 0.1, 1.0);
          } else {
            links.push({
              source: src,
              target: tgt,
              type: 'shared-topic',
              label: `Topic: ${topic}`,
              strength: 0.2,
              sharedTopics: 1,
            });
          }
        }
      }
    }
  });

  // Build topic clusters
  const clusters = {};
  topicIndex.forEach((members, topic) => {
    clusters[topic] = members;
  });

  return { nodes, links, clusters };
}

// ── Graph Statistics ──

export function getGraphStats(graphData) {
  const { nodes, links } = graphData;
  const parentChildLinks = links.filter(l => l.type === 'parent-child');
  const topicLinks = links.filter(l => l.type === 'shared-topic');

  // Find isolated nodes (no links)
  const linkedNodes = new Set();
  links.forEach(l => { linkedNodes.add(l.source); linkedNodes.add(l.target); });
  const isolatedCount = nodes.length - linkedNodes.size;

  // Find largest cluster
  const groups = new Map();
  nodes.forEach(n => {
    const g = n.group;
    groups.set(g, (groups.get(g) || 0) + 1);
  });
  const largestCluster = Math.max(...groups.values(), 0);

  return {
    totalNodes: nodes.length,
    totalLinks: links.length,
    parentChildLinks: parentChildLinks.length,
    topicLinks: topicLinks.length,
    isolatedNodes: isolatedCount,
    serviceGroups: groups.size,
    largestCluster,
  };
}

// ── SVG Force-Directed Graph Renderer ──

const GRAPH_COLORS = {
  'parent-child': 'rgba(91,163,245,0.5)',
  'shared-topic': 'rgba(192,132,252,0.3)',
  'shared-field': 'rgba(52,211,153,0.3)',
};

const GEOMETRY_COLORS = {
  'POINT': '#34d399',
  'POLYGON': '#5ba3f5',
  'POLYLINE': '#10b981',
  'TABLE': '#fbbf24',
  'MULTIPOINT': '#34d399',
  'MULTIPATCH': '#c084fc',
};

const STAGE_SHAPES = {
  'production': 'circle',
  'qa': 'diamond',
  'in_development': 'square',
  'planned': 'triangle',
  'deprecated': 'cross',
};

/**
 * Render the relationship graph as an interactive SVG within a container element.
 */
export function renderRelationshipGraph(containerEl, graphData, options = {}) {
  if (!containerEl || !graphData) return;

  const { nodes, links } = graphData;
  if (nodes.length === 0) {
    containerEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No datasets to visualize.</p>';
    return;
  }

  const width = options.width || containerEl.clientWidth || 800;
  const height = options.height || 500;
  const nodeRadius = options.nodeRadius || 6;

  // Simple force simulation (no d3 dependency — basic spring-electric)
  const simNodes = nodes.map((n, i) => ({
    ...n,
    x: width / 2 + (Math.random() - 0.5) * width * 0.6,
    y: height / 2 + (Math.random() - 0.5) * height * 0.6,
    vx: 0,
    vy: 0,
    idx: i,
  }));

  const simLinks = links.map(l => ({
    ...l,
    sourceNode: simNodes[l.source],
    targetNode: simNodes[l.target],
  }));

  // Run simulation
  const iterations = Math.min(150, 50 + nodes.length);
  const repulsion = 800;
  const springLength = 80;
  const springStrength = 0.04;
  const damping = 0.85;
  const centerPull = 0.01;

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations;

    // Repulsion between all pairs
    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const a = simNodes[i], b = simNodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsion * temp / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Spring attraction for linked nodes
    simLinks.forEach(l => {
      const a = l.sourceNode, b = l.targetNode;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const displacement = dist - springLength;
      const force = springStrength * displacement * l.strength * temp;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });

    // Center gravity
    simNodes.forEach(n => {
      n.vx += (width / 2 - n.x) * centerPull;
      n.vy += (height / 2 - n.y) * centerPull;
    });

    // Apply velocities
    simNodes.forEach(n => {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
      // Keep in bounds
      n.x = Math.max(nodeRadius + 5, Math.min(width - nodeRadius - 5, n.x));
      n.y = Math.max(nodeRadius + 5, Math.min(height - nodeRadius - 5, n.y));
    });
  }

  // Render SVG
  let svg = `<svg class="relationship-graph-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg">`;

  // Defs for arrows
  svg += `<defs>
    <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="rgba(255,255,255,0.2)"/>
    </marker>
  </defs>`;

  // Links
  simLinks.forEach(l => {
    const color = GRAPH_COLORS[l.type] || 'rgba(255,255,255,0.1)';
    const strokeWidth = l.type === 'parent-child' ? 1.5 : 0.8;
    svg += `<line class="graph-link" x1="${l.sourceNode.x}" y1="${l.sourceNode.y}" x2="${l.targetNode.x}" y2="${l.targetNode.y}" stroke="${color}" stroke-width="${strokeWidth}" data-link-type="${l.type}">`;
    svg += `<title>${escapeHtml(l.label || l.type)}</title>`;
    svg += `</line>`;
  });

  // Nodes
  simNodes.forEach(n => {
    const color = GEOMETRY_COLORS[n.geometry?.toUpperCase()] || 'rgba(255,255,255,0.4)';
    const r = nodeRadius;
    svg += `<circle class="graph-node" cx="${n.x}" cy="${n.y}" r="${r}" fill="${color}" stroke="rgba(255,255,255,0.1)" stroke-width="1" data-node-id="${escapeHtml(n.id)}" style="cursor:pointer;">`;
    svg += `<title>${escapeHtml(n.label)} (${escapeHtml(n.geometry)})</title>`;
    svg += `</circle>`;
  });

  // Labels for major nodes (large service groups)
  const groups = new Map();
  simNodes.forEach(n => {
    groups.set(n.group, (groups.get(n.group) || 0) + 1);
  });
  simNodes.forEach(n => {
    if ((groups.get(n.group) || 0) >= 3) {
      const truncLabel = n.label.length > 20 ? n.label.slice(0, 17) + '…' : n.label;
      svg += `<text class="graph-label" x="${n.x}" y="${n.y - nodeRadius - 3}" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.5)">${escapeHtml(truncLabel)}</text>`;
    }
  });

  svg += `</svg>`;

  // Legend
  let legend = '<div class="graph-legend">';
  legend += '<span class="graph-legend-item"><span class="graph-legend-line" style="background:rgba(91,163,245,0.5);"></span> Same Service</span>';
  legend += '<span class="graph-legend-item"><span class="graph-legend-line" style="background:rgba(192,132,252,0.3);"></span> Shared Topic</span>';
  legend += '<span class="graph-legend-divider"></span>';
  Object.entries(GEOMETRY_COLORS).forEach(([geom, color]) => {
    legend += `<span class="graph-legend-item"><span class="graph-legend-dot" style="background:${color};"></span> ${geom}</span>`;
  });
  legend += '</div>';

  containerEl.innerHTML = svg + legend;

  // Wire click events on nodes
  containerEl.querySelectorAll('circle.graph-node').forEach(circle => {
    circle.addEventListener('click', () => {
      const id = circle.getAttribute('data-node-id');
      if (id) {
        // Dispatch custom event so external code can handle navigation
        containerEl.dispatchEvent(new CustomEvent('graph-node-click', { detail: { datasetId: id }, bubbles: true }));
      }
    });

    // Hover effect
    circle.addEventListener('mouseenter', () => {
      circle.setAttribute('r', String(nodeRadius * 1.8));
      circle.style.filter = 'brightness(1.4)';
      // Highlight connected links
      const nodeId = circle.getAttribute('data-node-id');
      const nodeIdx = simNodes.findIndex(n => n.id === nodeId);
      containerEl.querySelectorAll('line.graph-link').forEach(line => {
        const srcMatch = simLinks.find(l =>
          (l.sourceNode.idx === nodeIdx || l.targetNode.idx === nodeIdx) &&
          Math.abs(l.sourceNode.x - parseFloat(line.getAttribute('x1'))) < 0.5
        );
        // This is a simplification; for a production version, use data attributes
      });
    });
    circle.addEventListener('mouseleave', () => {
      circle.setAttribute('r', String(nodeRadius));
      circle.style.filter = '';
    });
  });
}

/**
 * Render a statistics summary for the graph in a container.
 */
export function renderGraphStats(containerEl, stats) {
  if (!containerEl) return;
  let html = '<div class="graph-stats-row">';
  html += `<span class="graph-stat"><strong>${stats.totalNodes}</strong> datasets</span>`;
  html += `<span class="graph-stat"><strong>${stats.totalLinks}</strong> relationships</span>`;
  html += `<span class="graph-stat"><strong>${stats.serviceGroups}</strong> service groups</span>`;
  html += `<span class="graph-stat"><strong>${stats.parentChildLinks}</strong> sibling links</span>`;
  html += `<span class="graph-stat"><strong>${stats.topicLinks}</strong> topic links</span>`;
  html += `<span class="graph-stat"><strong>${stats.isolatedNodes}</strong> isolated</span>`;
  html += '</div>';
  containerEl.innerHTML = html;
}
