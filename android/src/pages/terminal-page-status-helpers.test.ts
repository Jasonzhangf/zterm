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

  it('keeps file, image, and remote screenshot actions enabled for every session', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('herdr', false)).toEqual({
      fileTransferSupported: true,
      imagePasteSupported: true,
      remoteScreenshotSupported: true,
    });
  });

  it('does not gate image actions on backend or remote-window input', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('herdr', true)).toEqual({
      fileTransferSupported: true,
      imagePasteSupported: true,
      remoteScreenshotSupported: true,
    });
  });
});
