import { describe, expect, it, vi } from 'vitest';
import {
  JUNCTION_PREVIEW_LATTICE_STORAGE_KEY,
  clearJunctionPreviewCell,
  moveJunctionPreviewFocus,
  readJunctionPreviewLattice,
  resolveJunctionPreviewCell,
  setJunctionPreviewCell,
  writeJunctionPreviewLattice,
  type JunctionPreviewLatticeV1,
  type JunctionPreviewTarget,
} from './junction-preview-lattice';

const target = (index: number): JunctionPreviewTarget => ({
  sessionId: `session-${index}`,
  bridgeHost: 'mac.local',
  bridgePort: 3333,
  sessionName: `tmux-${index}`,
});

const emptyLattice = (): JunctionPreviewLatticeV1 => ({ version: 1, cells: [] });

describe('junction preview lattice truth', () => {
  it('sets one target per coordinate without moving another cell', () => {
    const first = setJunctionPreviewCell(emptyLattice(), { col: 0, row: 0 }, target(1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = setJunctionPreviewCell(first.lattice, { col: -1, row: 0 }, target(2));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.lattice.cells).toEqual([
      { col: 0, row: 0, target: target(1) },
      { col: -1, row: 0, target: target(2) },
    ]);

    const replaced = setJunctionPreviewCell(second.lattice, { col: 0, row: 0 }, target(3));
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.lattice.cells).toEqual([
      { col: 0, row: 0, target: target(3) },
      { col: -1, row: 0, target: target(2) },
    ]);

    const duplicate = setJunctionPreviewCell(replaced.lattice, { col: 0, row: 0 }, target(2));
    expect(duplicate).toEqual({
      ok: false,
      reason: 'session-already-assigned',
      lattice: replaced.lattice,
    });
  });

  it('clears only the selected coordinate and rejects malformed targets', () => {
    const lattice = {
      version: 1 as const,
      cells: [
        { col: 0, row: 0, target: target(1) },
        { col: 1, row: 0, target: target(2) },
      ],
    };
    expect(clearJunctionPreviewCell(lattice, { col: 0, row: 0 })).toEqual({
      version: 1,
      cells: [{ col: 1, row: 0, target: target(2) }],
    });
    expect(setJunctionPreviewCell(lattice, { col: 0, row: 1 }, {
      ...target(3),
      sessionId: '',
    })).toEqual({ ok: false, reason: 'invalid-target', lattice });
  });

  it('moves focus one coordinate at a time without mutating cell ownership', () => {
    expect(moveJunctionPreviewFocus({ col: 0, row: 0 }, 'left')).toEqual({ col: -1, row: 0 });
    expect(moveJunctionPreviewFocus({ col: 0, row: 0 }, 'right')).toEqual({ col: 1, row: 0 });
    expect(moveJunctionPreviewFocus({ col: 0, row: 0 }, 'up')).toEqual({ col: 0, row: -1 });
    expect(moveJunctionPreviewFocus({ col: 0, row: 0 }, 'down')).toEqual({ col: 0, row: 1 });
  });

  it('resolves a stored target only when the current open session identity matches', () => {
    const lattice = setJunctionPreviewCell(
      emptyLattice(),
      { col: 0, row: 0 },
      { ...target(1), daemonHostId: 'daemon-a' },
    );
    expect(lattice.ok).toBe(true);
    if (!lattice.ok) return;

    expect(resolveJunctionPreviewCell(lattice.lattice, { col: 0, row: 0 }, [{
      id: 'session-1',
      daemonHostId: 'daemon-a',
      bridgeHost: 'mac.local',
      bridgePort: 3333,
      sessionName: 'tmux-1',
    }])?.id).toBe('session-1');

    expect(resolveJunctionPreviewCell(lattice.lattice, { col: 0, row: 0 }, [{
      id: 'session-1',
      daemonHostId: 'daemon-b',
      bridgeHost: 'mac.local',
      bridgePort: 3333,
      sessionName: 'tmux-1',
    }])).toBeNull();
  });

  it('persists valid lattice and exposes invalid storage instead of silently returning empty truth', () => {
    const storage = {
      getItem: vi.fn(() => '{bad json'),
      setItem: vi.fn(),
    };
    expect(readJunctionPreviewLattice(storage)).toMatchObject({ status: 'invalid' });

    const lattice = setJunctionPreviewCell(emptyLattice(), { col: 0, row: 0 }, target(1));
    expect(lattice.ok).toBe(true);
    if (!lattice.ok) return;
    expect(writeJunctionPreviewLattice(storage, lattice.lattice)).toEqual({ ok: true });
    expect(storage.setItem).toHaveBeenCalledWith(
      JUNCTION_PREVIEW_LATTICE_STORAGE_KEY,
      JSON.stringify(lattice.lattice),
    );
  });

  it('rejects persisted lattices that assign one session to multiple coordinates', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({
        version: 1,
        cells: [
          { col: 0, row: 0, target: target(1) },
          { col: 1, row: 0, target: target(1) },
        ],
      })),
      setItem: vi.fn(),
    };

    expect(readJunctionPreviewLattice(storage)).toMatchObject({ status: 'invalid' });
  });
});
