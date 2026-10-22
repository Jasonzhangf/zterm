import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const mainEntry = join(packageRoot, 'src', 'main.ts');
const fixtureEntry = join(packageRoot, 'src', 'fixture-entry.ts');
const distEntry = join(packageRoot, 'dist', 'main.mjs');
const fixtureMode = process.argv.includes('--fixture');
const entry = fixtureMode ? fixtureEntry : mainEntry;

if (!existsSync(entry)) {
  console.error(
    fixtureMode
      ? `zterm-cli fixture entry not found: ${entry}`
      : `zterm-cli main entry not found: ${entry}; build the CLI composition entry before packing.`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

rmSync(distEntry, { force: true });
mkdirSync(dirname(distEntry), { recursive: true });

try {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: distEntry,
    external: ['ws', '@roamhq/wrtc'],
    define: {
      __ZTERM_CLI_VERSION__: JSON.stringify(manifest.version),
    },
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
