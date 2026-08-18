import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const runtimePackages = [
  '@jsonstudio/wtermmod-core',
  '@jsonstudio/wtermmod-dom',
  '@jsonstudio/wtermmod-react',
];

const result = [];
for (const name of runtimePackages) {
  const range = packageJson.dependencies?.[name];
  if (!range) {
    throw new Error(`missing runtime dependency: ${name}`);
  }
  const expected = range.replace(/^[~^]/, '');
  const published = execFileSync('npm', [
    'view',
    name,
    'version',
    '--fetch-timeout=60000',
    '--fetch-retries=2',
  ], {
    encoding: 'utf8',
    timeout: 180000,
  }).trim();
  const ok = published === expected;
  result.push({ name, expected, published, ok });
}

console.log(JSON.stringify({ ok: result.every((item) => item.ok), packages: result }, null, 2));
if (!result.every((item) => item.ok)) {
  process.exit(1);
}
