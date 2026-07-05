// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBridgeServerPresetIdentityId, type BridgeSettings, type EditableHost, type Host } from '@zterm/shared';
import { ConnectionLauncher } from './ConnectionLauncher';

function makeSettings(): BridgeSettings {
  return {
    defaultServerId: buildBridgeServerPresetIdentityId('127.0.0.1', 3333),
    servers: [],
    targetHost: '127.0.0.1',
    targetPort: 3333,
    targetAuthToken: 'token-a',
    terminalThemeId: 'default',
    widthMode: 'adaptive-phone',
  } as any;
}

function makeHost(id: string, sessionName: string, lastConnected: number): Host {
  return {
    id,
    name: sessionName,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName,
    authToken: 'token-a',
    authType: 'password',
    tags: [],
    pinned: false,
    lastConnected,
  };
}

beforeEach(() => {
  (window as any).ztermMac = {
    localTmux: {
      listSessions: vi.fn().mockResolvedValue([]),
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as any).ztermMac;
});

describe('ConnectionLauncher QuickConnect discovery', () => {
  it('discovers remote sessions and preselects the latest saved matching session', async () => {
    const sessionFetcher = vi.fn().mockResolvedValue(['alpha', 'beta', 'alpha']);
    const onSaveDraft = vi.fn();
    const { container, findByText } = render(
      <ConnectionLauncher
        open={true}
        hosts={[makeHost('old', 'alpha', 10), makeHost('new', 'beta', 20)]}
        bridgeSettings={makeSettings()}
        onClose={vi.fn()}
        onOpenHost={vi.fn()}
        onOpenLocalTmuxSession={vi.fn()}
        onSaveDraft={onSaveDraft}
        sessionFetcher={sessionFetcher}
      />,
    );

    const discoverButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Discover sessions'),
    ) as HTMLButtonElement | undefined;
    expect(discoverButton).toBeTruthy();
    fireEvent.click(discoverButton!);

    expect(await findByText('beta')).toBeTruthy();
    expect(sessionFetcher).toHaveBeenCalledWith({
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      authToken: 'token-a',
    });

    const beta = container.querySelector('input[name="mac-quick-session-beta"]') as HTMLInputElement | null;
    expect(beta?.checked).toBe(true);

    const openButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & connect'),
    ) as HTMLButtonElement | undefined;
    expect(openButton).toBeTruthy();
    fireEvent.click(openButton!);

    expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      authToken: 'token-a',
      sessionName: 'beta',
      name: 'beta',
    }) satisfies Partial<EditableHost>, undefined, true);
  });

  it('surfaces discovery errors without opening a target', async () => {
    const sessionFetcher = vi.fn().mockRejectedValue(new Error('daemon refused list-sessions'));
    const onSaveDraft = vi.fn();
    const { container, findByText } = render(
      <ConnectionLauncher
        open={true}
        hosts={[]}
        bridgeSettings={makeSettings()}
        onClose={vi.fn()}
        onOpenHost={vi.fn()}
        onOpenLocalTmuxSession={vi.fn()}
        onSaveDraft={onSaveDraft}
        sessionFetcher={sessionFetcher}
      />,
    );

    const discoverButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Discover sessions'),
    ) as HTMLButtonElement | undefined;
    fireEvent.click(discoverButton!);

    expect(await findByText('daemon refused list-sessions')).toBeTruthy();
    await waitFor(() => expect(sessionFetcher).toHaveBeenCalledTimes(1));
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('clears a discovered selected session when the remote target changes', async () => {
    const sessionFetcher = vi.fn().mockResolvedValue(['alpha', 'beta']);
    const onSaveDraft = vi.fn();
    const { container, findByText } = render(
      <ConnectionLauncher
        open={true}
        hosts={[makeHost('old', 'beta', 20)]}
        bridgeSettings={makeSettings()}
        onClose={vi.fn()}
        onOpenHost={vi.fn()}
        onOpenLocalTmuxSession={vi.fn()}
        onSaveDraft={onSaveDraft}
        sessionFetcher={sessionFetcher}
      />,
    );

    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Discover sessions'),
    )!);
    expect(await findByText('beta')).toBeTruthy();

    const hostInput = Array.from(container.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('Bridge host'),
    )?.querySelector('input') as HTMLInputElement | null;
    expect(hostInput).toBeTruthy();
    fireEvent.change(hostInput!, { target: { value: '127.0.0.2' } });

    expect(container.querySelector('input[name="mac-quick-session-beta"]')).toBeNull();
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & connect'),
    )!);

    expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({
      bridgeHost: '127.0.0.2',
      sessionName: '',
      name: '127.0.0.2',
    }) satisfies Partial<EditableHost>, undefined, true);
  });
});
