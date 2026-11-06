// Atomic JSON file store for member runtime bindings. Separate file and schema
// from the organization authority tree: organization owns membership, members
// owns the current session binding and the runtime configuration record.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function emptyState() {
  // runtimeConfigs keeps machineId/hostKind/agentKind/launchProfileRef in the
  // members store. Organization only keeps the structural member reference.
  return { version: 1, bindings: {}, runtimeConfigs: {}, generations: {} };
}

export function createBindingStore(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('binding store requires a file path');
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
    const state = { ...emptyState(), ...JSON.parse(text) };
    // Legacy version-1 stores predate the generations map. Backfill the
    // monotonic counter from the authoritative binding so an existing
    // generation can never be reset to 0 and reissued as 1.
    if (!state.generations || typeof state.generations !== 'object') {
      state.generations = {};
    }
    for (const [memberId, binding] of Object.entries(state.bindings ?? {})) {
      if (!binding || !Number.isInteger(binding.generation)) continue;
      const current = state.generations[memberId];
      if (current === undefined || binding.generation > current) {
        state.generations[memberId] = binding.generation;
      }
    }
    return state;
  }

  async function persist(state) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, file);
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


