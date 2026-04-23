import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import { getWtermHomeDir } from './daemon-config';

export interface ScheduleStoreData {
  schemaVersion: number;
  jobs: ScheduleJob[];
  updatedAt: string;
}

const CURRENT_SCHEMA_VERSION = 1;

export function getScheduleStorePath(homeDir = homedir()) {
  return join(getWtermHomeDir(homeDir), 'schedules.json');
}

export function loadScheduleStore(storePath = getScheduleStorePath()): ScheduleStoreData {
  if (!existsSync(storePath)) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      jobs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as Partial<ScheduleStoreData>;
    return {
      schemaVersion:
        typeof parsed.schemaVersion === 'number' && Number.isFinite(parsed.schemaVersion)
          ? parsed.schemaVersion
          : CURRENT_SCHEMA_VERSION,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs as ScheduleJob[] : [],
      updatedAt:
        typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      jobs: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

export function saveScheduleStore(jobs: ScheduleJob[], storePath = getScheduleStorePath()) {
  mkdirSync(dirname(storePath), { recursive: true });
  const payload: ScheduleStoreData = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    jobs,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(storePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}
