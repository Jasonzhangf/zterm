// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsFileBrowserPanel } from './WindowsFileBrowserPanel';

const base64 = (text: string) => btoa(text);
const fixture = () => ({
  readdir: vi.fn(async (target: string) => target === 'C:/fixture' ? {
    ok: true,
    path: 'C:/fixture',
    entries: [
      { name: 'src', type: 'directory', size: 0, modified: 1, path: 'C:\\fixture\\src' },
      { name: 'README.md', type: 'file', size: 20, modified: 2, path: 'C:\\fixture\\README.md' },
      { name: 'image.png', type: 'file', size: 40, modified: 3, path: 'C:\\fixture\\image.png' },
    ],
  } : { ok: false, path: target, entries: [], error: `Missing ${target}` }),
  readFile: vi.fn(async () => ({ ok: true, dataBase64: base64('WINDOWS_PREVIEW_DOM'), size: 19 })),
  selectDirectory: vi.fn(async () => ({ ok: true, path: 'C:/fixture' })),
});

afterEach(cleanup);

describe('WindowsFileBrowserPanel', () => {
  it('lists through the Windows bridge and previews Markdown through shared policy', async () => {
    const fileSystem = fixture();
    render(<WindowsFileBrowserPanel open onClose={vi.fn()} initialPath="C:/fixture" fileSystem={fileSystem as any} />);
    fireEvent.click(await screen.findByText('README.md'));
    expect(await screen.findByTestId('windows-file-preview-text')).toHaveTextContent('WINDOWS_PREVIEW_DOM');
    expect(fileSystem.readFile).toHaveBeenCalledWith('C:\\fixture\\README.md');
  });

  it('does not read binary files and surfaces provider errors', async () => {
    const fileSystem = fixture();
    const view = render(<WindowsFileBrowserPanel open onClose={vi.fn()} initialPath="C:/fixture" fileSystem={fileSystem as any} />);
    fireEvent.click(await screen.findByText('image.png'));
    expect(await screen.findByTestId('windows-file-preview-disabled')).toBeDisabled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();

    view.rerender(<WindowsFileBrowserPanel open onClose={vi.fn()} initialPath="C:/missing" fileSystem={fileSystem as any} />);
    await waitFor(() => expect(screen.getByTestId('windows-file-browser-error')).toHaveTextContent('Missing C:/missing'));
  });
});
