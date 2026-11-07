import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeProbeScratch } from './cleanup-receipt.mjs';

const scratchRoot = await mkdtemp(join(tmpdir(), 'zterm-cleanup-refusal-'));
const sentinel = join(scratchRoot, 'owned-data.txt');
await writeFile(sentinel, 'preserve me\n', 'utf8');

try {
  const cleanup = await finalizeProbeScratch({
    scratchRoot,
    childResult: { pid: 424242, exited: false, exitCode: null, signalCode: null },
    transcript: ['controlled nonexistent-child cleanup refusal'],
  });
  const sentinelPreserved = await access(sentinel).then(() => true, () => false);
  const scratchPreserved = cleanup.scratchDirRemoved === false && cleanup.exited === false;
  const ok = cleanup.ok === false && sentinelPreserved && scratchPreserved;

  console.log(JSON.stringify({
    mode: 'cleanup-refusal-helper',
    realDaemonSpawned: false,
    cleanup,
    sentinelPreserved,
    scratchPreserved,
    ok,
  }, null, 2));

  if (!ok) throw new Error('cleanup refusal assertion failed');
} finally {
  await rm(scratchRoot, { recursive: true, force: true });
}
