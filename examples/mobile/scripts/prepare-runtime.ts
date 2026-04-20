import { ensureNodePtySpawnHelpersExecutable } from '../src/server/node-pty-runtime.ts';

const result = ensureNodePtySpawnHelpersExecutable();

if (!result.packageRoot) {
  console.warn('[wterm-mobile] node-pty not installed yet; skip runtime prepare');
  process.exit(0);
}

if (result.checkedHelpers.length === 0) {
  console.log(`[wterm-mobile] no node-pty spawn-helper found under ${result.packageRoot}`);
  process.exit(0);
}

if (result.repairedHelpers.length > 0) {
  console.log(
    `[wterm-mobile] repaired node-pty spawn-helper permissions:\n${result.repairedHelpers
      .map((item) => `  - ${item}`)
      .join('\n')}`,
  );
} else {
  console.log(`[wterm-mobile] node-pty spawn-helper permissions already OK (${result.checkedHelpers.length} checked)`);
}
