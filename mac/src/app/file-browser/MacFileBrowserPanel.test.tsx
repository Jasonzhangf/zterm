// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacFileBrowserPanel } from './MacFileBrowserPanel';

function base64(text: string) {
  return btoa(text);
}

function createFixtureFileSystem() {
  const readdir = vi.fn(async (dirPath: string) => {
    if (dirPath === '/fixture') {
      return {
        ok: true,
        path: '/fixture',
        entries: [
          { name: 'image.png', type: 'file', size: 1200, modified: 2, modifiedMs: 2000, path: '/fixture/image.png' },
          { name: 'README.md', type: 'file', size: 28, modified: 1, modifiedMs: 1000, path: '/fixture/README.md' },
          { name: 'large.log', type: 'file', size: 900 * 1024, modified: 3, modifiedMs: 3000, path: '/fixture/large.log' },
          { name: 'src', type: 'directory', size: 0, modified: 4, modifiedMs: 4000, path: '/fixture/src' },
        ],
      };
    }
    if (dirPath === '/fixture/src') {
      return {
        ok: true,
        path: '/fixture/src',
        entries: [
          { name: 'index.ts', type: 'file', size: 12, modified: 5, modifiedMs: 5000, path: '/fixture/src/index.ts' },
        ],
      };
    }
    return {
      ok: false,
      path: dirPath,
      entries: [],
      error: `Missing fixture path ${dirPath}`,
    };
  });
  const readFile = vi.fn(async (filePath: string) => {
    if (filePath === '/fixture/README.md') {
      return { ok: true, dataBase64: base64('hello from fixture\n'), size: 19 };
    }
    if (filePath === '/fixture/large.log') {
      return { ok: true, dataBase64: base64('large confirmed\n'), size: 16 };
    }
    return { ok: false, dataBase64: '', size: 0, error: `Missing file ${filePath}` };
  });
  return {
    readdir,
    readFile,
    saveFile: vi.fn(),
    mkdir: vi.fn(),
    getDownloadDir: vi.fn(),
    selectDirectory: vi.fn(async () => ({ ok: true, path: '/fixture/src' })),
  };
}

afterEach(() => {
  cleanup();
  delete (window as any).ztermMac;
});

describe('MacFileBrowserPanel', () => {
  it('opens a local fixture directory and previews a text file', async () => {
    const fileSystem = createFixtureFileSystem();
    render(<MacFileBrowserPanel open onClose={vi.fn()} initialPath="/fixture" fileSystem={fileSystem as any} />);

    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();

    fireEvent.click(screen.getByText('README.md'));

    await waitFor(() => {
      expect(screen.getByTestId('mac-file-preview-text')).toHaveTextContent('hello from fixture');
    });
    expect(fileSystem.readFile).toHaveBeenCalledWith('/fixture/README.md');
  });

  it('disables binary preview without reading the file', async () => {
    const fileSystem = createFixtureFileSystem();
    render(<MacFileBrowserPanel open onClose={vi.fn()} initialPath="/fixture" fileSystem={fileSystem as any} />);

    fireEvent.click(await screen.findByText('image.png'));

    expect(await screen.findByTestId('mac-file-preview-disabled')).toBeDisabled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before reading a large text file', async () => {
    const fileSystem = createFixtureFileSystem();
    render(<MacFileBrowserPanel open onClose={vi.fn()} initialPath="/fixture" fileSystem={fileSystem as any} />);

    fireEvent.click(await screen.findByText('large.log'));
    expect(await screen.findByTestId('mac-file-preview-confirm')).toBeInTheDocument();
    expect(fileSystem.readFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('mac-file-preview-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('mac-file-preview-text')).toHaveTextContent('large confirmed');
    });
    expect(fileSystem.readFile).toHaveBeenCalledWith('/fixture/large.log');
  });

  it('uses explicit directory selection as an open intent', async () => {
    const fileSystem = createFixtureFileSystem();
    render(<MacFileBrowserPanel open onClose={vi.fn()} fileSystem={fileSystem as any} />);

    fireEvent.click(screen.getByText('Choose'));

    expect(await screen.findByText('index.ts')).toBeInTheDocument();
    expect(fileSystem.selectDirectory).toHaveBeenCalledTimes(1);
    expect(fileSystem.readdir).toHaveBeenCalledWith('/fixture/src');
  });

  it('surfaces provider errors instead of showing an empty directory', async () => {
    const fileSystem = createFixtureFileSystem();
    render(<MacFileBrowserPanel open onClose={vi.fn()} initialPath="/missing" fileSystem={fileSystem as any} />);

    expect(await screen.findByTestId('mac-file-browser-error')).toHaveTextContent('Missing fixture path /missing');
    expect(screen.queryByText('No entries')).not.toBeInTheDocument();
  });

  it('does not call terminal runtime bridges while browsing files', async () => {
    const fileSystem = createFixtureFileSystem();
    const connect = vi.fn();
    const disconnect = vi.fn();
    (window as any).ztermMac = {
      platform: 'mac',
      fileSystem,
      localTmux: {
        listSessions: vi.fn(),
        connect,
        disconnect,
      },
    };

    render(<MacFileBrowserPanel open onClose={vi.fn()} initialPath="/fixture" />);
    fireEvent.click(await screen.findByText('README.md'));

    await waitFor(() => {
      expect(screen.getByTestId('mac-file-preview-text')).toHaveTextContent('hello from fixture');
    });
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });
});

