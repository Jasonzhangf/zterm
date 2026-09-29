import { describe, expect, it } from 'vitest';
import {
  setZtermVerificationDownload,
  takeZtermVerificationDownload,
} from './zterm-verification-queue';

describe('zterm verification queue', () => {
  it('keeps the deep-link verification target until the sheet is mounted', () => {
    setZtermVerificationDownload({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });

    const target = takeZtermVerificationDownload();
    expect(target).toEqual({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });
    expect(takeZtermVerificationDownload()).toBeNull();
  });

  it('clears explicit null and does not leak to the next sheet open', () => {
    setZtermVerificationDownload({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3112.bin',
      size: 52428800,
    });
    setZtermVerificationDownload(null);

    expect(takeZtermVerificationDownload()).toBeNull();
  });
});
