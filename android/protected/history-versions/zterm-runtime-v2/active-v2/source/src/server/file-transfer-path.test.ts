import { describe, expect, it, vi } from 'vitest';
import { resolveFileTransferListPath } from './file-transfer-path';

describe('resolveFileTransferListPath', () => {
  it('uses the explicit requested path without consulting tmux cwd truth', () => {
    const readCurrentSessionPath = vi.fn(() => '/remote/current');
    expect(resolveFileTransferListPath('/tmp/demo', readCurrentSessionPath)).toBe('/tmp/demo');
    expect(readCurrentSessionPath).not.toHaveBeenCalled();
  });

  it('falls back to current tmux pane path only when request path is empty', () => {
    const readCurrentSessionPath = vi.fn(() => '/remote/current/project');
    expect(resolveFileTransferListPath('', readCurrentSessionPath)).toBe('/remote/current/project');
    expect(readCurrentSessionPath).toHaveBeenCalledTimes(1);
  });

  it('throws when neither request path nor current tmux pane path exists', () => {
    expect(() => resolveFileTransferListPath('', () => '   ')).toThrow('tmux pane current path unavailable');
  });
});
