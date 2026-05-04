import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();
const roots = [
  { dir: join(repoRoot, 'android', 'src'), label: 'android/src' },
  { dir: join(repoRoot, 'packages', 'shared', 'src'), label: 'packages/shared/src' },
  { dir: join(repoRoot, 'android'), label: 'android config root', exact: ['vite.config.js'] },
];

const polluted = [];

function walk(dir, visit) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '.git') continue;
      walk(full, visit);
      continue;
    }
    visit(full);
  }
}

for (const root of roots) {
  if (!existsSync(root.dir)) continue;
  if (root.exact) {
    for (const name of root.exact) {
      const file = join(root.dir, name);
      if (existsSync(file)) polluted.push(relative(repoRoot, file));
    }
    continue;
  }
  walk(root.dir, (file) => {
    if (!file.endsWith('.js')) return;
    const base = file.slice(0, -3);
    if (
      existsSync(`${base}.ts`) ||
      existsSync(`${base}.tsx`) ||
      existsSync(`${base}.mts`) ||
      existsSync(`${base}.cts`)
    ) {
      polluted.push(relative(repoRoot, file));
    }
  });
}

if (polluted.length > 0) {
  console.error('[source-js-pollution] Found generated JS inside source-of-truth trees:');
  for (const file of polluted) {
    console.error(` - ${file}`);
  }
  process.exit(1);
}

console.log('[source-js-pollution] clean');
