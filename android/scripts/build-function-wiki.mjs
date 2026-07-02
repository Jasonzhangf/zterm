import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');

const pages = [
  ['daemon.md', 'Daemon Wiki'],
  ['cli.md', 'CLI Wiki'],
  ['mainline-source.md', 'Mainline Source Wiki'],
];

function extractFirstMermaid(source) {
  const match = source.match(/```mermaid\n([\s\S]*?)```/);
  if (!match) {
    throw new Error('missing mermaid block');
  }
  return match[1].trim();
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseMermaidFlowchart(diagram) {
  const labels = new Map();
  const edges = [];
  const lines = diagram
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('flowchart'));

  const nodePattern = /^([A-Za-z0-9_]+)(?:\["([^"]+)"\])?$/;

  function readNode(raw) {
    const match = raw.trim().match(nodePattern);
    if (!match) {
      throw new Error(`unsupported mermaid node syntax: ${raw}`);
    }
    const [, id, label] = match;
    if (label) {
      labels.set(id, label);
    } else if (!labels.has(id)) {
      labels.set(id, id);
    }
    return id;
  }

  for (const line of lines) {
    const parts = line.split(/\s*-->\s*/);
    if (parts.length !== 2) {
      throw new Error(`unsupported mermaid edge syntax: ${line}`);
    }
    const from = readNode(parts[0]);
    const to = readNode(parts[1]);
    edges.push({ from, to });
  }

  return { labels, edges };
}

function layoutGraph(graph) {
  const incoming = new Map();
  const outgoing = new Map();
  for (const id of graph.labels.keys()) {
    incoming.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to]);
  }

  const queue = Array.from(graph.labels.keys()).filter((id) => (incoming.get(id) || 0) === 0);
  const layerById = new Map(queue.map((id) => [id, 0]));

  while (queue.length > 0) {
    const from = queue.shift();
    const nextLayer = (layerById.get(from) || 0) + 1;
    for (const to of outgoing.get(from) || []) {
      layerById.set(to, Math.max(layerById.get(to) || 0, nextLayer));
      incoming.set(to, (incoming.get(to) || 0) - 1);
      if ((incoming.get(to) || 0) === 0) {
        queue.push(to);
      }
    }
  }

  for (const id of graph.labels.keys()) {
    if (!layerById.has(id)) layerById.set(id, 0);
  }

  const layers = new Map();
  for (const [id, layer] of layerById) {
    layers.set(layer, [...(layers.get(layer) || []), id]);
  }

  const positions = new Map();
  const nodeWidth = 260;
  const nodeHeight = 56;
  const xGap = 70;
  const yGap = 34;
  const maxRows = Math.max(...Array.from(layers.values()).map((ids) => ids.length));
  const width = Math.max(640, layers.size * (nodeWidth + xGap) + xGap);
  const height = Math.max(220, maxRows * (nodeHeight + yGap) + yGap);

  for (const [layer, ids] of layers) {
    ids.forEach((id, index) => {
      positions.set(id, {
        x: xGap + layer * (nodeWidth + xGap),
        y: yGap + index * (nodeHeight + yGap),
      });
    });
  }

  return { positions, width, height, nodeWidth, nodeHeight };
}

function renderSvg(diagram) {
  const graph = parseMermaidFlowchart(diagram);
  const layout = layoutGraph(graph);

  const edgeMarkup = graph.edges.map((edge) => {
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    if (!from || !to) throw new Error(`missing graph position for ${edge.from} -> ${edge.to}`);
    const x1 = from.x + layout.nodeWidth;
    const y1 = from.y + layout.nodeHeight / 2;
    const x2 = to.x;
    const y2 = to.y + layout.nodeHeight / 2;
    const midX = x1 + Math.max(24, (x2 - x1) / 2);
    return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" class="edge" marker-end="url(#arrow)" />`;
  }).join('\n');

  const nodeMarkup = Array.from(graph.labels.entries()).map(([id, label]) => {
    const pos = layout.positions.get(id);
    if (!pos) throw new Error(`missing graph position for ${id}`);
    return `<g class="node" data-node-id="${escapeHtml(id)}">
  <rect x="${pos.x}" y="${pos.y}" width="${layout.nodeWidth}" height="${layout.nodeHeight}" rx="12" />
  <text x="${pos.x + 16}" y="${pos.y + 34}">${escapeHtml(label)}</text>
</g>`;
  }).join('\n');

  return `<svg class="wiki-graph" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Mainline graph">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" class="arrow" />
    </marker>
  </defs>
  ${edgeMarkup}
  ${nodeMarkup}
</svg>`;
}

function renderHtml(title, diagram) {
  const svg = renderSvg(diagram);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body { margin: 24px; background: #f7f3ea; color: #1d2525; font-family: ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 24px; margin-bottom: 18px; }
.wiki-graph { width: 100%; max-width: 1400px; min-height: 220px; background: #fffaf0; border: 1px solid #d9cdb9; border-radius: 18px; box-shadow: 0 12px 36px rgba(50, 40, 25, 0.12); }
.node rect { fill: #fbf7ed; stroke: #365b54; stroke-width: 1.5; }
.node text { fill: #1d2525; font-size: 13px; font-weight: 650; }
.edge { fill: none; stroke: #b46a3c; stroke-width: 2; }
.arrow { fill: #b46a3c; }
.source { margin-top: 18px; white-space: pre-wrap; color: #5a635f; font-size: 12px; }
</style></head><body>
<h1>${title}</h1>
${svg}
<pre class="source">${escapeHtml(diagram)}</pre>
</body></html>
`;
}

const outDir = join(root, 'docs/wiki/generated');
mkdirSync(outDir, { recursive: true });

for (const [file, title] of pages) {
  const sourcePath = join(root, 'docs/wiki', file);
  const diagram = extractFirstMermaid(readFileSync(sourcePath, 'utf8'));
  writeFileSync(join(outDir, file.replace(/\.md$/, '.html')), renderHtml(title, diagram));
}
