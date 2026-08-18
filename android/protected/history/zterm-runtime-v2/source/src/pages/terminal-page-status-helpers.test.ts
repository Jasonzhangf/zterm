import { describe, expect, it } from 'vitest';
import { resolveTerminalQuickBarCapabilityProjection } from './terminal-page-status-helpers';

describe('resolveTerminalQuickBarCapabilityProjection', () => {
  it('keeps tmux file, image paste, and remote screenshot capabilities enabled', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('tmux', false)).toEqual({
      fileTransferSupported: true,
      imagePasteSupported: true,
      remoteScreenshotSupported: true,
    });
  });

  it('keeps Herdr file transfer and remote screenshot disabled without remote-window input', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('herdr', false)).toEqual({
      fileTransferSupported: false,
      imagePasteSupported: false,
      remoteScreenshotSupported: false,
    });
  });

  it('enables Herdr image paste only while remote-window input is active', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('herdr', true)).toEqual({
      fileTransferSupported: false,
      imagePasteSupported: true,
      remoteScreenshotSupported: false,
    });
  });
});
