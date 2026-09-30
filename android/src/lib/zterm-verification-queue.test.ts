import { describe, expect, it } from 'vitest';
import {
  claimZtermVerificationDownload,
  setZtermVerificationDownload,
} from './zterm-verification-queue';

describe('zterm verification queue', () => {
  it('keeps the deep-link verification target until the sheet is mounted', () => {
    setZtermVerificationDownload({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });

    const target = claimZtermVerificationDownload();
    expect(target).toEqual({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });
    expect(claimZtermVerificationDownload()).toBeNull();
  });

  it('claims exactly once so the verification intent has a single owner', () => {
    setZtermVerificationDownload({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });

    expect(claimZtermVerificationDownload()).toEqual({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });
    expect(claimZtermVerificationDownload()).toBeNull();
  });

  it('clears explicit null and does not leak to the next sheet open', () => {
    setZtermVerificationDownload({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });
    setZtermVerificationDownload(null);

    expect(claimZtermVerificationDownload()).toBeNull();
  });
});
