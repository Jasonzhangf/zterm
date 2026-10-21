import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep, win32 } from 'node:path';

function invocationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pathApi(platform) {
  return platform === 'win32' ? win32 : { basename, dirname, isAbsolute, resolve };
}

function commandHasPath(command, platform) {
  return (
    pathApi(platform).isAbsolute(command) ||
    command.includes('/') ||
    command.includes(sep) ||
    command.includes('\\')
  );
}

function isNpmCommand(command, platform) {
  return /^npm(?:\.cmd|\.exe)?$/i.test(pathApi(platform).basename(command));
}

function isNpmCliEntry(path, platform) {
  return pathApi(platform).basename(path).toLowerCase() === 'npm-cli.js';
}

function unique(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function npmCliCandidates(npmCommand, platform, execPath, env) {
  const path = pathApi(platform);
  const candidates = [];
  const npmExecPath = env.npm_execpath;

  if (npmExecPath && isNpmCliEntry(npmExecPath, platform)) {
    candidates.push(npmExecPath);
  }

  if (isNpmCliEntry(npmCommand, platform) && path.isAbsolute(npmCommand)) {
    candidates.push(npmCommand);
  } else if (commandHasPath(npmCommand, platform)) {
    const commandDir = path.dirname(npmCommand);
    candidates.push(
      platform === 'win32'
        ? path.join(commandDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : path.resolve(commandDir, '../lib/node_modules/npm/bin/npm-cli.js'),
    );
  }

  const nodeDir = path.dirname(execPath);
  candidates.push(
    platform === 'win32'
      ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'),
  );
  return unique(candidates);
}

export function resolveNodeScriptInvocation(scriptPath, args, execPath = process.execPath) {
  return {
    command: execPath,
    args: [scriptPath, ...args],
  };
}

export function resolveNpmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const npmCommand = options.npmCommand ?? 'npm';
  if (!isNpmCommand(npmCommand, platform)) {
    return { command: npmCommand, args };
  }

  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  const candidates = npmCliCandidates(npmCommand, platform, execPath, env);
  const npmCli = candidates.find((candidate) => pathExists(candidate));

  if (!npmCli) {
    throw invocationError(
      'npm_entry_unavailable',
      `cannot resolve the official npm-cli.js for ${npmCommand}; checked: ${candidates.join(', ')}`,
    );
  }

  return resolveNodeScriptInvocation(npmCli, args, execPath);
}
