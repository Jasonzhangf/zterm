import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(import.meta.dirname, '..');
const releaseDist = resolve(projectRoot, 'release-dist');
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const tarball = resolve(releaseDist, `jsonstudio-zterm-relay-server-${version}.tgz`);
const shaFile = `${tarball}.sha256`;

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`missing relay server release asset: ${path}`);
  return path;
}

function sha256(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function readSha(path) {
  return readFileSync(path, 'utf8').trim().split(/\s+/)[0];
}

function listTarballEntries(path) {
  return execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readTarballText(path, entry) {
  return execFileSync('tar', ['-xOf', path, entry], { encoding: 'utf8' });
}

function hasEntry(entries, expected) {
  return entries.includes(expected) || entries.some((entry) => entry.startsWith(`${expected}/`));
}

requireFile(tarball);
requireFile(shaFile);
const entries = listTarballEntries(tarball);
const packedPackageJson = JSON.parse(readTarballText(tarball, 'package/package.json'));
const bin = readTarballText(tarball, 'package/bin/zterm-relay-server');
const readme = readTarballText(tarball, 'package/README.md');

const checks = {
  relayServerShaMatches: sha256(tarball) === readSha(shaFile),
  relayServerPackageName: packedPackageJson.name === '@jsonstudio/zterm-relay-server',
  relayServerPackageVersion: packedPackageJson.version === version,
  relayServerHasBin: hasEntry(entries, 'package/bin/zterm-relay-server'),
  relayServerHasRuntime: hasEntry(entries, 'package/runtime/server.cjs'),
  relayServerHasSmoke: hasEntry(entries, 'package/runtime/smoke.cjs'),
  relayServerBinRunsServer: bin.includes('runtime/server.cjs'),
  relayServerBinRunsSmoke: bin.includes('runtime/smoke.cjs'),
  relayServerReadmeHasSmoke: readme.includes('zterm-relay-server smoke --base-url'),
  relayServerReadmeHasEnv: readme.includes('ZTERM_TRAVERSAL_BASE_PATH') && readme.includes('ZTERM_TRAVERSAL_UPDATES_DIR') && readme.includes('ZTERM_TURN_URL'),
  relayServerReadmeHasUpdatesRoute: readme.includes('/relay/updates/latest.json'),
  relayServerNotDaemonPackage: packedPackageJson.name !== '@jsonstudio/zterm-daemon' && !bin.includes('zterm-daemon'),
};

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, version, tarball, sha256: readSha(shaFile), checks }, null, 2));
if (!ok) process.exit(1);
