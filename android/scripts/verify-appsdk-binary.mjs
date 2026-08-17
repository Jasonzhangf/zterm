import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(process.argv[2] ?? '.');
const lockPath = join(projectRoot, '.appsdk', 'sdk.lock');
const projectPath = join(projectRoot, '.appsdk', 'project.json');

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue until the executable selected by PATH is found.
    }
  }
  throw new Error(`APPSDK_BINARY_MISSING:${name}`);
}

const [lock, project, binaryPath] = await Promise.all([
  readFile(lockPath, 'utf8').then(JSON.parse),
  readFile(projectPath, 'utf8').then(JSON.parse),
  findExecutable('appsdk'),
]);

const binary = await readFile(binaryPath);
const digest = `sha256:${createHash('sha256').update(binary).digest('hex')}`;
const expectedVersion = project?.sdk?.version;
const versionProbe = spawnSync(binaryPath, ['version'], { encoding: 'utf8' });
const actualVersion = versionProbe.stdout.trim();

if (versionProbe.status !== 0) {
  throw new Error(`APPSDK_VERSION_PROBE_FAILED:${binaryPath}`);
}
if (lock.version !== expectedVersion) {
  throw new Error(`APPSDK_LOCK_VERSION_MISMATCH:${lock.version}:${expectedVersion}`);
}
if (actualVersion !== `appsdk ${expectedVersion} (rust)`) {
  throw new Error(`APPSDK_BINARY_VERSION_MISMATCH:${actualVersion}:${expectedVersion}`);
}
if (lock.digest !== digest || lock.compiler_digest !== digest) {
  throw new Error(`APPSDK_BINARY_DIGEST_MISMATCH:${digest}:${lock.compiler_digest}`);
}

console.log(JSON.stringify({ ok: true, binary: binaryPath, version: expectedVersion, digest }));
