// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTerminalPageOverlays } from './useTerminalPageOverlays';

const alertSpy = vi.fn();
vi.stubGlobal('alert', alertSpy);
const createObjectURLSpy = vi.fn(() => 'blob:preview');
const revokeObjectURLSpy = vi.fn();
vi.stubGlobal('URL', {
  createObjectURL: createObjectURLSpy,
  revokeObjectURL: revokeObjectURLSpy,
});


afterEach(() => {
  alertSpy.mockClear();
});

describe('useTerminalPageOverlays', () => {
  it('toggles overlay booleans and opens schedule/file transfer entries', () => {
    const onRequestScheduleList = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPageOverlays({
        uiSessionId: 's1',
        onRequestScheduleList,
      }),
    );

    act(() => result.current.handleQuickBarOpenScheduleComposer('pwd'));
    expect(result.current.scheduleOpen).toBe(true);
    expect(result.current.scheduleComposerSeed.text).toBe('pwd');
    expect(onRequestScheduleList).toHaveBeenCalledWith('s1');

    act(() => result.current.handleQuickBarOpenFileTransfer());
    expect(result.current.fileTransferOpen).toBe(true);
    expect(result.current.fileTransferMode).toBe('browser');

    act(() => result.current.handleQuickBarOpenFileTransfer('sync'));
    expect(result.current.fileTransferOpen).toBe(true);
    expect(result.current.fileTransferMode).toBe('sync');

    act(() => result.current.handleQuickBarToggleDebugOverlay());
    expect(result.current.debugOverlayVisible).toBe(true);

    act(() => result.current.handleQuickBarToggleAbsoluteLineNumbers());
    expect(result.current.absoluteLineNumbersVisible).toBe(true);
  });

  it('requests remote screenshot and closes preview', async () => {
    const onRequestRemoteScreenshot = vi.fn(async (_sessionId, onProgress) => {
      onProgress?.({ stage: 'capturing', progress: 0.5 } as any);
      return {
        fileName: 'shot.png',
        mimeType: 'image/png',
        dataBase64: 'YWJj',
        totalBytes: 3,
      } as any;
    });

    const { result } = renderHook(() =>
      useTerminalPageOverlays({
        uiSessionId: 's1',
        onRequestRemoteScreenshot,
      }),
    );

    act(() => result.current.handleQuickBarRequestRemoteScreenshot());

    await waitFor(() => {
      expect(onRequestRemoteScreenshot).toHaveBeenCalledWith('s1', expect.any(Function));
      expect(result.current.remoteScreenshotPreview?.phase).toBe('preview-ready');
    });

    act(() => result.current.closeRemoteScreenshotPreview());
    expect(result.current.remoteScreenshotPreview).toBeNull();
  });
});
