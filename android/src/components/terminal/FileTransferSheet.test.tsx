// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTransferSheet } from './FileTransferSheet';

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    ExternalStorage: 'ExternalStorage',
  },
  Filesystem: {
    readdir: vi.fn().mockResolvedValue({ files: [] }),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

afterEach(() => {
  cleanup();
});

describe('FileTransferSheet', () => {
  it('requests daemon current session cwd when the sheet opens without a client-side path truth', async () => {
    const sendJson = vi.fn();

    render(
      <FileTransferSheet
        open
        remoteCwd=""
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith({
        type: 'file-list-request',
        payload: expect.objectContaining({
          path: '',
          showHidden: false,
        }),
      });
    });
  });

  it('does not re-request the same remote directory only because parent passed a new sendJson callback identity', async () => {
    const sendJsonA = vi.fn();
    const sendJsonB = vi.fn();
    const onFileTransferMessage = vi.fn(() => () => {});

    const view = render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJsonA}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => {
      expect(sendJsonA).toHaveBeenCalledWith({
        type: 'file-list-request',
        payload: expect.objectContaining({
          path: '/remote/home',
          showHidden: false,
        }),
      });
    });
    const initialCalls = sendJsonA.mock.calls.length;

    view.rerender(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJsonB}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(sendJsonA).toHaveBeenCalledTimes(initialCalls);
    expect(sendJsonB).not.toHaveBeenCalled();
  });
});
