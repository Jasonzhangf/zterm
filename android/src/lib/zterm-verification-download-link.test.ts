import { describe, expect, it } from 'vitest';
import { parseZtermVerificationDownloadLink } from './zterm-verification-download-link';

describe('zterm verification download link', () => {
  it('accepts the Android-safe slash path without query separators', () => {
    const parsed = parseZtermVerificationDownloadLink(
      'zterm://file-download-verification/p/tmp/zterm-rtfp-50mb-3125.bin/52428800',
    );

    expect(parsed).toEqual({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3125.bin',
      size: 52428800,
    });
  });

  it('keeps legacy query form compatibility', () => {
    const parsed = parseZtermVerificationDownloadLink(
      'zterm://file-download-verification?p=%2Ftmp&f=zterm-rtfp-50mb-3125.bin&s=52428800',
    );

    expect(parsed).toEqual({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3125.bin',
      size: 52428800,
    });
  });
});
