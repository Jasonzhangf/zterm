import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import { loadScheduleStore, saveScheduleStore } from './schedule-store';

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'zterm-schedule-store-'));
  tempDirs.push(dir);
  return dir;
}

function makeJob(id: string): ScheduleJob {
  return {
    id,
    targetSessionName: 'main',
    label: 'job',
    enabled: true,
    payload: { text: 'echo hi', appendEnter: true },
    rule: {
      kind: 'alarm',
      timezone: 'Asia/Shanghai',
      date: '2026-04-26',
      time: '09:30',
      repeat: 'once',
    },
    execution: { maxRuns: 3, firedCount: 0 },
    createdAt: '2026-04-26T01:00:00.000Z',
    updatedAt: '2026-04-26T01:00:00.000Z',
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('schedule-store', () => {
  it('persists jobs and reloads them without silent data loss', () => {
    const dir = createTempDir();
    const storePath = join(dir, 'state', 'schedules.json');
    const jobs = [makeJob('job-1'), makeJob('job-2')];

    saveScheduleStore(jobs, storePath);
    const loaded = loadScheduleStore(storePath);

    expect(loaded.jobs).toEqual(jobs);
    expect(loaded.schemaVersion).toBe(1);
    expect(typeof loaded.updatedAt).toBe('string');
  });

  it('returns an explicit empty store when the file does not exist', () => {
    const dir = createTempDir();
    const storePath = join(dir, 'missing', 'schedules.json');

    const loaded = loadScheduleStore(storePath);

    expect(loaded.jobs).toEqual([]);
    expect(loaded.schemaVersion).toBe(1);
  });

  it('throws an explicit error on corrupted JSON instead of silently falling back', () => {
    const dir = createTempDir();
    const storePath = join(dir, 'broken', 'schedules.json');
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(storePath, '{not-valid-json', 'utf-8');

    expect(() => loadScheduleStore(storePath)).toThrow(/Failed to load/);
  });
});
