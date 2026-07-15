import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SESSION_PREVIEW_SELECTION,
  SESSION_PREVIEW_SELECTION_STORAGE_KEY,
  appendSessionPreviewTarget,
  moveSessionPreviewTarget,
  projectSessionPreviewLiveIds,
  pruneSessionPreviewSelectionToOpenSessions,
  readSessionPreviewSelection,
  removeSessionPreviewTarget,
  replaceSessionPreviewTarget,
  resolveSessionPreviewTargets,
  toggleSessionPreviewTarget,
  writeSessionPreviewSelection,
  type SessionPreviewSelectionV1,
  type SessionPreviewTarget,
} from './session-preview-selection';

const target = (index: number): SessionPreviewTarget => ({
  sessionId: `session-${index}`,
  bridgeHost: 'mac.local',
  bridgePort: 3333,
  sessionName: `tmux-${index}`,
});

const emptySelection = (): SessionPreviewSelectionV1 => ({ version: 1, orderedTargets: [] });

describe('session preview selection truth', () => {
  it('adds and removes unique targets while preserving order', () => {
    let selection = emptySelection();
    for (let index = 1; index <= MAX_SESSION_PREVIEW_SELECTION; index += 1) {
      const result = toggleSessionPreviewTarget(selection, target(index));
      expect(result.ok).toBe(true);
      if (result.ok) selection = result.selection;
    }
    expect(selection.orderedTargets.map((item) => item.sessionId)).toEqual([
      'session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6',
    ]);

    const removed = toggleSessionPreviewTarget(selection, target(3));
    expect(removed.ok && removed.selection.orderedTargets.map((item) => item.sessionId)).toEqual([
      'session-1', 'session-2', 'session-4', 'session-5', 'session-6',
    ]);
  });

  it('rejects a seventh target without changing selection', () => {
    const selection = {
      version: 1 as const,
      orderedTargets: Array.from({ length: 6 }, (_, index) => target(index + 1)),
    };
    expect(toggleSessionPreviewTarget(selection, target(7))).toEqual({
      ok: false,
      reason: 'limit',
      selection,
    });
  });

  it('replaces one selected target in place and rejects selected or missing replacements', () => {
    const selection = {
      version: 1 as const,
      orderedTargets: [target(1), target(2), target(3)],
    };
    expect(replaceSessionPreviewTarget(selection, 'session-2', target(9))).toEqual({
      ok: true,
      selection: {
        version: 1,
        orderedTargets: [target(1), target(9), target(3)],
      },
    });
    expect(replaceSessionPreviewTarget(selection, 'session-2', target(3))).toEqual({
      ok: false,
      reason: 'already-selected',
      selection,
    });
    expect(replaceSessionPreviewTarget(selection, 'session-missing', target(9))).toEqual({
      ok: false,
      reason: 'source-missing',
      selection,
    });
  });

  it('appends, removes, and moves preview targets without toggling the wrong semantic', () => {
    const selection = {
      version: 1 as const,
      orderedTargets: [target(1), target(2), target(3), target(4)],
    };
    expect(appendSessionPreviewTarget(selection, target(5))).toEqual({
      ok: true,
      selection: { version: 1, orderedTargets: [target(1), target(2), target(3), target(4), target(5)] },
    });
    expect(appendSessionPreviewTarget(selection, target(2))).toEqual({
      ok: false,
      reason: 'already-selected',
      selection,
    });
    expect(removeSessionPreviewTarget(selection, 'session-2')).toEqual({
      ok: true,
      selection: { version: 1, orderedTargets: [target(1), target(3), target(4)] },
    });
    expect(removeSessionPreviewTarget(selection, 'session-9')).toEqual({
      ok: false,
      reason: 'source-missing',
      selection,
    });
    expect(moveSessionPreviewTarget(selection, 'session-4', 1)).toEqual({
      ok: true,
      selection: { version: 1, orderedTargets: [target(1), target(4), target(2), target(3)] },
    });
  });

  it('resolves only current open sessions and projects a deduped preview live set', () => {
    const selection = { version: 1 as const, orderedTargets: [target(1), target(2), target(3)] };
    const open = (index: number) => ({
      id: `session-${index}`,
      bridgeHost: 'mac.local',
      bridgePort: 3333,
      sessionName: `tmux-${index}`,
    });
    const sessions = [open(1), open(3), open(9)];
    expect(resolveSessionPreviewTargets(selection, sessions).map((item) => item.id)).toEqual([
      'session-1', 'session-3',
    ]);
    expect(projectSessionPreviewLiveIds(['session-1'], ['session-1', 'session-3'], true, true)).toEqual([
      'session-1', 'session-3',
    ]);
    expect(projectSessionPreviewLiveIds(['session-1'], ['session-3'], false, true)).toEqual(['session-1']);
    expect(projectSessionPreviewLiveIds(['session-1'], ['session-3'], true, false)).toEqual(['session-1']);
  });

  it('rejects a reused session id whose host or tmux identity no longer matches the stored target', () => {
    const selection = {
      version: 1 as const,
      orderedTargets: [{ ...target(1), daemonHostId: 'daemon-a' }],
    };
    expect(resolveSessionPreviewTargets(selection, [{
      id: 'session-1',
      bridgeHost: 'other.local',
      bridgePort: 3333,
      sessionName: 'tmux-1',
      daemonHostId: 'daemon-a',
    }])).toEqual([]);
    expect(resolveSessionPreviewTargets(selection, [{
      id: 'session-1',
      bridgeHost: 'mac.local',
      bridgePort: 3333,
      sessionName: 'tmux-reused',
      daemonHostId: 'daemon-a',
    }])).toEqual([]);
    expect(resolveSessionPreviewTargets(selection, [{
      id: 'session-1',
      bridgeHost: 'mac.local',
      bridgePort: 3333,
      sessionName: 'tmux-1',
      daemonHostId: 'daemon-b',
    }])).toEqual([]);

    const pruned = pruneSessionPreviewSelectionToOpenSessions(selection, [{
      id: 'session-1',
      bridgeHost: 'mac.local',
      bridgePort: 3333,
      sessionName: 'tmux-1',
      daemonHostId: 'daemon-b',
    }]);
    expect(pruned).toEqual({ version: 1, orderedTargets: [] });
  });

  it('persists valid selection and exposes invalid storage instead of silently returning empty success', () => {
    const storage = {
      getItem: vi.fn(() => '{bad json'),
      setItem: vi.fn(),
    };
    expect(readSessionPreviewSelection(storage)).toMatchObject({ status: 'invalid' });

    const selection = { version: 1 as const, orderedTargets: [target(1)] };
    expect(writeSessionPreviewSelection(storage, selection)).toEqual({ ok: true });
    expect(storage.setItem).toHaveBeenCalledWith(
      SESSION_PREVIEW_SELECTION_STORAGE_KEY,
      JSON.stringify(selection),
    );
  });
});
