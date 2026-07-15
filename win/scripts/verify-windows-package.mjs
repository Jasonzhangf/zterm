import { existsSync, readFileSync, statSync } from 'node:fs';
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

console.log(JSON.stringify({
  ok: true,
  installer: installerPath,
  installerSize: statSync(installerPath).size,
  sha512,
  updateManifest: join(root, 'out', 'alpha.yml'),
}, null, 2));
