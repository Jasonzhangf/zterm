import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAdaptiveWidthOwnershipStore,
  getAdaptiveWidthOwnershipStorePath,
} from './adaptive-width-ownership-store';

const tempDirs: string[] = [];

function createStorePath() {
  const dir = mkdtempSync(join(tmpdir(), 'zterm-adaptive-width-'));
  tempDirs.push(dir);
  return join(dir, 'state', 'adaptive-width.json');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('adaptive width ownership store', () => {
  it('persists daemon-owned pane identity and baseline without a tmux option', () => {
    const storePath = createStorePath();
    const store = createAdaptiveWidthOwnershipStore(storePath);

    store.upsert({
      sessionName: 'demo',
      paneId: '%1',
      baseline: { cols: 120, rows: 40 },
      appliedCols: 55,
      appliedRows: 24,
    });

    expect(store.read()).toEqual([
      expect.objectContaining({
        sessionName: 'demo',
        paneId: '%1',
        baseline: { cols: 120, rows: 40 },
        appliedCols: 55,
        appliedRows: 24,
      }),
    ]);
    expect(readFileSync(storePath, 'utf8')).not.toContain('@zterm_adaptive_width_');
  });

  it('replaces one session record and removes it after release', () => {
    const storePath = createStorePath();
    const store = createAdaptiveWidthOwnershipStore(storePath);

    store.upsert({
      sessionName: 'demo',
      paneId: '%1',
      baseline: { cols: 120, rows: 40 },
      appliedCols: 80,
      appliedRows: 24,
    });
    store.upsert({
      sessionName: 'demo',
      paneId: '%1',
      baseline: { cols: 120, rows: 40 },
      appliedCols: 60,
      appliedRows: 24,
    });
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0]?.appliedCols).toBe(60);

    store.remove('demo');
    expect(store.read()).toEqual([]);
  });

  it('ignores malformed records instead of inventing ownership', () => {
    const storePath = createStorePath();
    mkdirSync(join(storePath, '..'), { recursive: true });
    writeFileSync(storePath, JSON.stringify({
      schemaVersion: 1,
      records: [
        { sessionName: 'bad', paneId: '', baseline: { cols: 120, rows: 40 }, appliedCols: 60 },
        { sessionName: 'good', paneId: '%2', baseline: { cols: 100, rows: 30 }, appliedCols: 50, appliedRows: 20 },
      ],
    }), 'utf8');

    expect(createAdaptiveWidthOwnershipStore(storePath).read()).toEqual([
      expect.objectContaining({ sessionName: 'good', paneId: '%2' }),
    ]);
  });

  it('resolves the journal under the zterm runtime home', () => {
    expect(getAdaptiveWidthOwnershipStorePath('/tmp/home')).toBe('/tmp/home/.zterm/adaptive-width.json');
  });
});
