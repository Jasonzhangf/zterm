import { describe, expect, it } from 'vitest';
import { resolveNpmInvocation } from '../scripts/process-entry.mjs';

const windowsNode = 'C:\\Program Files\\nodejs\\node.exe';
const windowsNpmCli =
  'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

describe('CLI script process entry', () => {
  it('uses the official npm JS entry and Node instead of spawning npm.cmd', () => {
    const invocation = resolveNpmInvocation(['pack', '--ignore-scripts'], {
      platform: 'win32',
      execPath: windowsNode,
      env: {},
      pathExists: (path) => path === windowsNpmCli,
    });

    expect(invocation).toEqual({
      command: windowsNode,
      args: [windowsNpmCli, 'pack', '--ignore-scripts'],
    });
    expect(invocation.command).not.toMatch(/\.cmd$/i);
  });

  it('fails explicitly when the official Windows npm JS entry is unavailable', () => {
    expect(() =>
      resolveNpmInvocation(['pack'], {
        platform: 'win32',
        execPath: windowsNode,
        env: {},
        pathExists: () => false,
      }),
    ).toThrowError(/npm-cli\.js/);
  });

  it('recognizes a Windows npm JS entry from npm_execpath', () => {
    const windowsNpmCliFromTool =
      'C:\\Tools\\node\\npm\\bin\\npm-cli.js';
    const invocation = resolveNpmInvocation(['pack'], {
      platform: 'win32',
      execPath: windowsNode,
      env: { npm_execpath: windowsNpmCliFromTool },
      pathExists: (path) => path === windowsNpmCliFromTool,
    });

    expect(invocation).toEqual({
      command: windowsNode,
      args: [windowsNpmCliFromTool, 'pack'],
    });
  });
});
