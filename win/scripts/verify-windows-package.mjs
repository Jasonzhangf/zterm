import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = [
  join(root, 'build', 'icon.ico'),
  join(root, 'out', 'win-unpacked', 'ZTerm.exe'),
  join(root, 'out', `ZTerm-${pkg.version}-x64.exe`),
  join(root, 'out', 'alpha.yml'),
];

const missing = required.filter((file) => !existsSync(file));
if (missing.length) {
  throw new Error(`missing Windows package artifacts: ${missing.join(', ')}`);
}

if (!pkg.build?.win?.icon || !String(pkg.build.win.icon).endsWith('icon.ico')) {
  throw new Error('build.win.icon must point at build/icon.ico');
}
const targets = JSON.stringify(pkg.build?.win?.target ?? []);
if (!targets.includes('nsis') || !targets.includes('dir')) {
  throw new Error('build.win.target must include dir and nsis');
}
if (!Array.isArray(pkg.build?.publish) || pkg.build.publish[0]?.provider !== 'generic') {
  throw new Error('build.publish must declare the generic update channel');
}

const installerPath = join(root, 'out', `ZTerm-${pkg.version}-x64.exe`);
const installer = readFileSync(installerPath);
const latest = readFileSync(join(root, 'out', 'alpha.yml'), 'utf8');
const sha512 = createHash('sha512').update(installer).digest('base64');
if (!latest.includes(`ZTerm-${pkg.version}-x64.exe`) || !latest.includes(sha512)) {
  throw new Error('alpha.yml does not match the generated installer');
}

// electron-builder only packs production dependencies. A runtime import declared
// as a devDependency leaves the packaged main process unable to resolve it, which
// shows up as a live app with no renderer rather than a build failure.
const asarPath = join(root, 'out', 'win-unpacked', 'resources', 'app.asar');
const { header, dataStart } = readAsarHeader(asarPath);
const packedDependencies = listPackedTopLevelPackages(header);
const missingDependencies = Object.keys(pkg.dependencies ?? {}).filter((name) => !packedDependencies.has(name));
if (missingDependencies.length) {
  throw new Error(`production dependencies missing from packaged app.asar: ${missingDependencies.join(', ')}`);
}

// A dependency folder alone is not enough: workspace packages ship compiled
// entrypoints, so the declared export target must exist inside the archive.
const unresolvedEntries = Object.keys(pkg.dependencies ?? {})
  .map((name) => [name, resolveDependencyEntry(header, name)])
  .filter(([, entryPath]) => !entryPath);
if (unresolvedEntries.length) {
  throw new Error(`production dependencies packaged without a resolvable entrypoint: ${unresolvedEntries.map(([name]) => name).join(', ')}`);
}

console.log(JSON.stringify({
  ok: true,
  installer: installerPath,
  installerSize: statSync(installerPath).size,
  sha512,
  updateManifest: join(root, 'out', 'alpha.yml'),
  entrypoints: Object.fromEntries(Object.keys(pkg.dependencies ?? {}).map((name) => [name, resolveDependencyEntry(header, name)])),
  packedDependencies: [...packedDependencies].sort(),
}, null, 2));

function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 16);
    // The archive header is a Pickle: the JSON blob is padded to a 4-byte
    // boundary, so the file payload starts after that padding.
    const padding = Buffer.alloc(4);
    readSync(fd, padding, 0, 4, 16 + headerSize);
    const paddingBytes = padding[0] === 0 ? (padding[1] === 0 ? 2 : 1) : 0;
    return {
      header: JSON.parse(header.toString('utf8').replace(/\0+$/, '')),
      dataStart: 16 + headerSize + paddingBytes,
    };
  } finally {
    closeSync(fd);
  }
}

function listPackedTopLevelPackages(header) {
  const nodeModules = header.files?.node_modules?.files ?? {};
  const names = new Set();
  for (const [entry, value] of Object.entries(nodeModules)) {
    if (entry.startsWith('@')) {
      for (const scoped of Object.keys(value.files ?? {})) {
        names.add(`${entry}/${scoped}`);
      }
      continue;
    }
    names.add(entry);
  }
  return names;
}

function resolveAsarEntry(header, parts) {
  let node = header.files;
  for (let index = 0; index < parts.length; index += 1) {
    const next = node?.[parts[index]];
    if (!next) return null;
    if (index === parts.length - 1) return next.files ? null : next;
    node = next.files;
  }
  return null;
}

function resolveDependencyEntry(header, name) {
  const asarPackagePath = name.startsWith('@') ? `node_modules/${name.replace('/', '/')}/package.json` : `node_modules/${name}/package.json`;
  const packageEntry = resolveAsarEntry(header, asarPackagePath.split('/'));
  if (!packageEntry) return null;
  const manifest = JSON.parse(readAsarFile(packageEntry).toString('utf8'));
  const exported = manifest.exports?.['.'] ?? manifest.exports;
  const target = typeof exported === 'string'
    ? exported
    : exported?.import ?? exported?.default ?? manifest.main;
  if (typeof target !== 'string') return null;
  const targetParts = [...`node_modules/${name}`.split('/'), ...target.replace(/^\.\//, '').split('/')];
  return resolveAsarEntry(header, targetParts) ? target : null;

  function readAsarFile(entry) {
    const fd = openSync(asarPath, 'r');
    try {
      const buffer = Buffer.alloc(entry.size);
      readSync(fd, buffer, 0, entry.size, dataStart + Number(entry.offset));
      return Buffer.from(buffer.toString('latin1').replace(/^\0+/, ''), 'latin1');
    } finally {
      closeSync(fd);
    }
  }
}
