import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { TypedError } from '../../../organization/src/public/index.mjs';

function emptyState() {
  return { version: 1, goals: {} };
}

function typedPersistFailure(cause) {
  return new TypedError('STORE_PERSIST_FAILED', 'goals store persist failed', {
    owningModule: 'goals',
    cause,
  });
}

export function createFileGoalStore(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('goals store requires a file path');
  }
  let chain = Promise.resolve();

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw typedPersistFailure(error);
    }
    try {
      return { ...emptyState(), ...JSON.parse(text) };
    } catch (cause) {
      throw typedPersistFailure(cause);
    }
  }

  async function persist(state) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temp, file);
    } catch (cause) {
      throw typedPersistFailure(cause);
    }
  }

  function update(mutator) {
    const run = chain.then(async () => {
      const state = await load();
      const result = await mutator(state);
      await persist(state);
      return result;
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function read() {
    return chain.then(load);
  }

  return Object.freeze({ read, update });
}
