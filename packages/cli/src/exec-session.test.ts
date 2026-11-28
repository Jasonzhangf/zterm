import { describe, expect, it } from 'vitest';
import {
  detectExecShell,
  extractMarkedOutput,
  wrapExecCommand,
} from './exec-session.js';

describe('exec-session helpers', () => {
  it('detects powershell vs posix from deviceName', () => {
    expect(detectExecShell('jason-hw-desktop | Windows x64 | PowerShell | 0.1.6')).toBe('powershell');
    expect(detectExecShell('coder2 | Ubuntu 22.04 x64 | tmux | 0.1.6')).toBe('posix');
    expect(detectExecShell('opwrt-1 | OpenWrt x86_64 | ash | lite-0.1.6')).toBe('posix');
  });

  it('wraps commands without literal marker collision in echoed command text', () => {
    const posix = wrapExecCommand('uname -a', 'abcd1234', 'posix');
    expect(posix).not.toContain('__ZT_abcd1234_S__');
    expect(posix).not.toContain('__ZT_abcd1234_E:');
    expect(posix).toContain('uname -a');
    expect(posix.endsWith('\r')).toBe(true);

    const ps = wrapExecCommand('Get-Date', 'abcd1234', 'powershell');
    expect(ps).not.toContain('__ZT_abcd1234_S__');
    expect(ps).not.toContain('__ZT_abcd1234_E:');
    expect(ps).toContain('Get-Date');
    expect(ps.endsWith('\r')).toBe(true);
  });

  it('extracts stdout and exit code strictly between markers', () => {
    const lines = [
      'root@opwrt:~# printf ...',
      '__ZT_deadbeef_S__',
      'Linux opwrt 6.6.10 x86_64',
      'up 2 days',
      '__ZT_deadbeef_E:0__',
      'root@opwrt:~# ',
    ];
    expect(extractMarkedOutput(lines, 'deadbeef')).toEqual({
      matched: true,
      exitCode: 0,
      output: 'Linux opwrt 6.6.10 x86_64\nup 2 days',
    });

    const failed = [
      '__ZT_deadbeef_S__',
      'cat: missing: No such file',
      '__ZT_deadbeef_E:2__',
    ];
    expect(extractMarkedOutput(failed, 'deadbeef')).toEqual({
      matched: true,
      exitCode: 2,
      output: 'cat: missing: No such file',
    });
  });

  it('returns partial output when end marker has not arrived yet', () => {
    const lines = ['__ZT_cafe1234_S__', 'line 1', 'line 2'];
    expect(extractMarkedOutput(lines, 'cafe1234')).toEqual({
      matched: false,
      partialOutput: 'line 1\nline 2',
    });
  });
});
