import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(process.argv[2] ?? '.');
const lockPath = join(projectRoot, '.appsdk', 'sdk.lock');
const projectPath = join(projectRoot, '.appsdk', 'project.json');

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue until the executable selected by PATH is found.
    }
  }
  throw new Error(`APPSDK_BINARY_MISSING:${name}`);
}

async function verifyPinnedAppSdkBinary() {
  const [lock, project, binaryPath] = await Promise.all([
    readFile(lockPath, 'utf8').then(JSON.parse),
    readFile(projectPath, 'utf8').then(JSON.parse),
    findExecutable('appsdk'),
  ]);

  const expectedVersion = project?.sdk?.version;

  if (lock.version !== expectedVersion) {
    throw new Error(`APPSDK_LOCK_VERSION_MISMATCH:${lock.version}:${expectedVersion}`);
  }
  const versionProbe = spawnSync(binaryPath, ['version'], { encoding: 'utf8' });
  const actualVersion = typeof versionProbe.stdout === 'string'
    ? versionProbe.stdout.trim()
    : '';
  if (versionProbe.error || versionProbe.status !== 0) {
    throw new Error(`APPSDK_VERSION_PROBE_FAILED:${binaryPath}`);
  }
  if (actualVersion !== `appsdk ${expectedVersion} (rust)`) {
    throw new Error(`APPSDK_BINARY_VERSION_MISMATCH:${actualVersion}:${expectedVersion}`);
  }

  console.log(JSON.stringify({ ok: true, binary: binaryPath, version: expectedVersion }));
  const verification = spawnSync(binaryPath, ['verify', projectRoot], { stdio: 'inherit' });
  if (verification.status !== 0) {
    throw new Error(`APPSDK_VERIFY_FAILED:${binaryPath}:${verification.status ?? verification.signal}`);
  }
}

await verifyPinnedAppSdkBinary();
