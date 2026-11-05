// Atomic JSON file store for the organization authority tree. Writes go to a
// temp file and are renamed into place. Read-modify-write updates are serialized
// per store instance; the store is a single-writer authority by design.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TypedError } from '../public/typed-error.mjs';

function emptyState() {
  return { version: 1, workspaces: {}, groups: {}, members: {}, mounts: {} };
}

export function createOrganizationStore(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('organization store requires a file path');
  }
  let chain = Promise.resolve();

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    return { ...emptyState(), ...JSON.parse(text) };
  }

  async function persist(state) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  }

  async function persistTyped(state) {
    try {
      await persist(state);
    } catch (cause) {
      throw new TypedError('STORE_PERSIST_FAILED', 'organization store persist failed', {
        owningModule: 'organization',
        cause,
      });
    }
  }

  function update(mutator) {
    const run = chain.then(async () => {
      const state = await load();
      const result = await mutator(state);
      await persistTyped(state);
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
