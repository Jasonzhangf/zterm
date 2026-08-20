import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { buildDisplayVersion, computeNormalVersionCode } from './app-version.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const inputPath = resolve(projectRoot, process.argv[2] || 'dist');
const buildNumber = Number.parseInt(process.argv[3] || '', 10);
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));

if (!Number.isSafeInteger(buildNumber) || buildNumber < 1000) {
  throw new Error(`invalid Android build number: ${process.argv[3] || '(missing)'}`);
}
if (!existsSync(inputPath)) {
  throw new Error(`web asset input not found: ${inputPath}`);
}

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function readAssetContents(path) {
  if (statSync(path).isDirectory()) {
    const files = collectFiles(path).filter((file) => /\.(?:html|js|css)$/u.test(file));
    return {
      files,
      contents: files.map((file) => readFileSync(file, 'utf8')).join('\n'),
    };
  }

  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' })
    .split('\n')
    .filter((entry) => /^assets\/public\/.*\.(?:html|js|css)$/u.test(entry));
  return {
    files: entries,
    contents: entries.map((entry) => execFileSync('unzip', ['-p', path, entry], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })).join('\n'),
  };
}

const expectedVersionName = buildDisplayVersion(packageJson.version, buildNumber);
const expectedVersionCode = String(computeNormalVersionCode(buildNumber));
const { files, contents } = readAssetContents(inputPath);
if (files.length === 0) {
  throw new Error(`no web assets found: ${inputPath}`);
}
if (!contents.includes(expectedVersionName)) {
  throw new Error(`web assets do not contain ${expectedVersionName}: ${inputPath}`);
}
if (!contents.includes(expectedVersionCode)) {
  throw new Error(`web assets do not contain versionCode ${expectedVersionCode}: ${inputPath}`);
}

const staleVersionMatches = contents.match(/0\.1\.3\.\d+/gu) || [];
const staleCodeMatches = contents.match(/11000\d+/gu) || [];
const unexpectedVersions = [...new Set(staleVersionMatches)].filter((value) => value !== expectedVersionName);
const unexpectedCodes = [...new Set(staleCodeMatches)].filter((value) => value !== expectedVersionCode);
if (unexpectedVersions.length > 0 || unexpectedCodes.length > 0) {
  throw new Error(
    `web assets contain unexpected version truth: versions=${unexpectedVersions.join(',') || 'none'} `
      + `codes=${unexpectedCodes.join(',') || 'none'}: ${inputPath}`,
  );
}

console.log(JSON.stringify({
  ok: true,
  assetRoot: inputPath,
  expectedVersionName,
  expectedVersionCode: Number(expectedVersionCode),
  files: files.map((path) => basename(path)),
}, null, 2));
