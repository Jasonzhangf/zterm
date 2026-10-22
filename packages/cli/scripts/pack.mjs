import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmInvocation } from './process-entry.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const mainEntry = join(packageRoot, 'src', 'main.ts');
const tarballDir = join(packageRoot, 'dist');

if (!existsSync(mainEntry)) {
  console.error(`cannot pack zterm-cli before src/main.ts exists: ${mainEntry}`);
  process.exit(1);
}

const build = spawnSync(process.execPath, [join(scriptDir, 'build.mjs')], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: false,
});
if (build.error) {
  console.error(build.error.message);
  process.exit(1);
}
if (build.status !== 0) {
  process.exit(build.status === null ? 1 : build.status);
}

mkdirSync(tarballDir, { recursive: true });
const npmInvocation = resolveNpmInvocation([
  'pack',
  '--ignore-scripts',
  '--pack-destination',
  tarballDir,
]);
const pack = spawnSync(
  npmInvocation.command,
  npmInvocation.args,
  {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: false,
  },
);
if (pack.error) {
  console.error(pack.error.message);
  process.exit(1);
}
process.exit(pack.status === null ? 1 : pack.status);
