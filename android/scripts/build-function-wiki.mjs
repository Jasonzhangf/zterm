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

function renderHtml(title, diagram) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs"; mermaid.initialize({ startOnLoad: true });</script></head><body>
<h1>${title}</h1>
<div class="mermaid">
${diagram}
</div>
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
