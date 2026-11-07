import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function finalizeProbeScratch({ scratchRoot, childResult, transcript }) {
  await writeFile(join(scratchRoot, 'transcript.txt'), transcript.join('\n'), 'utf8');

  if (childResult.exited !== true) {
    return {
      ...childResult,
      scratchRoot,
      scratchDirRemoved: false,
      ok: false,
      reason: 'owned child did not exit; scratch directory preserved',
    };
  }

  await rm(scratchRoot, { recursive: true, force: true });
  return {
    ...childResult,
    scratchRoot,
    scratchDirRemoved: true,
    ok: true,
    reason: null,
  };
}
