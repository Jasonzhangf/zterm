// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useZtermVerificationIntent } from './useZtermVerificationIntent';
import {
  claimZtermVerificationDownload,
  setZtermVerificationDownload,
} from '../lib/zterm-verification-queue';

afterEach(() => {
  cleanup();
  claimZtermVerificationDownload();
});

describe('useZtermVerificationIntent', () => {
  it('forwards a pending intent without consuming it before the sheet claims it', () => {
    const onIntent = vi.fn();
    setZtermVerificationDownload({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3171.bin',
      size: 52428800,
    });

    renderHook(() => useZtermVerificationIntent(onIntent));

    expect(onIntent).toHaveBeenCalledWith({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3171.bin',
      size: 52428800,
    });
    expect(claimZtermVerificationDownload()).toEqual({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3171.bin',
      size: 52428800,
    });
  });

  it('forwards intents published after the terminal page is mounted', () => {
    const onIntent = vi.fn();
    renderHook(() => useZtermVerificationIntent(onIntent));

    act(() => {
      setZtermVerificationDownload({
        remotePath: '/tmp',
        fileName: 'zterm-rtfp-50mb-3172.bin',
        size: 52428800,
      });
    });

    expect(onIntent).toHaveBeenCalledWith({
      remotePath: '/tmp',
      fileName: 'zterm-rtfp-50mb-3172.bin',
      size: 52428800,
    });
  });
});
