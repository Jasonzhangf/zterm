// @vitest-environment jsdom

import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  renderTree: vi.fn(),
  writeTextToClipboard: vi.fn(async (_text: string) => {}),
}));

vi.mock('react-dom/client', () => ({
  default: { createRoot: () => ({ render: harness.renderTree }) },
}));

vi.mock('./App', () => ({
  default: function CrashingApp(): never {
    throw new Error('Terminal mux channel is not open for session page-switch-1');
  },
}));

vi.mock('./components/ambient/input-modality-runtime', () => ({
  installInputModalityRuntime: () => {},
}));

vi.mock('./pages/terminal-copy-selection', () => ({
  writeTextToClipboard: harness.writeTextToClipboard,
}));

let boundaryTree: ReactElement;

beforeAll(async () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  await import('./main');
  boundaryTree = harness.renderTree.mock.calls[0]?.[0] as ReactElement;
});

afterEach(() => {
  cleanup();
  harness.writeTextToClipboard.mockClear();
});

describe('RootErrorBoundary diagnostics', () => {
  it('renders the real error name, message and stack in root-error-detail', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(boundaryTree);
      const detail = screen.getByTestId('root-error-detail');
      expect(detail.textContent).toContain(
        'Error: Terminal mux channel is not open for session page-switch-1',
      );
      expect(detail.textContent).toContain('at ');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('copies the full error detail through the native clipboard writer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(boundaryTree);
      fireEvent.click(screen.getByRole('button', { name: /复制错误详情|已复制/ }));
      await waitFor(() => expect(harness.writeTextToClipboard).toHaveBeenCalledTimes(1));
      const copied = String(harness.writeTextToClipboard.mock.calls[0][0]);
      expect(copied).toContain('Terminal mux channel is not open for session page-switch-1');
      expect(copied).toContain('[zterm:react-error]');
      expect(copied).toContain('--- componentStack ---');
    } finally {
      consoleError.mockRestore();
    }
  });
});
