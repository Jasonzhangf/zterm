import { describe, expect, it } from 'vitest';
import { extractApkSmokePrintableAsciiLines } from './android-apk-smoke-printable-dump';

describe('extractApkSmokePrintableAsciiLines', () => {
  it('keeps semantic ascii content across single-byte binary separators so auth tokens are not physically lost', () => {
    const buffer = Buffer.from([
      ...Buffer.from('{"targetAuthToken":"w'),
      0,
      ...Buffer.from('t'),
      0,
      ...Buffer.from('e'),
      0,
      ...Buffer.from('r'),
      0,
      ...Buffer.from('m'),
      0,
      ...Buffer.from('-4123456","targetHost":"100.66.1.82"}'),
      10,
    ]);

    expect(extractApkSmokePrintableAsciiLines(buffer)).toEqual([
      '{"targetAuthToken":"wterm-4123456","targetHost":"100.66.1.82"}',
    ]);
  });

  it('still splits at real newline boundaries and longer binary gaps', () => {
    const buffer = Buffer.from([
      ...Buffer.from('bridge-settings'),
      10,
      ...Buffer.from('{"targetHost":"100.66.1.82"}'),
      0,
      1,
      ...Buffer.from('tail'),
      10,
    ]);

    expect(extractApkSmokePrintableAsciiLines(buffer)).toEqual([
      'bridge-settings',
      '{"targetHost":"100.66.1.82"}',
      'tail',
    ]);
  });
});

