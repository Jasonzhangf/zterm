import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { getWtermHomeDir } from './daemon-config';
import type { TerminalGeometry } from './terminal-runtime-types';

export interface AdaptiveWidthOwnershipRecord {
  sessionName: string;
  paneId: string;
  baseline: TerminalGeometry;
  appliedCols: number;
  appliedRows: number;
  updatedAt: string;
}

interface AdaptiveWidthOwnershipStoreData {
  schemaVersion: 1;
  records: AdaptiveWidthOwnershipRecord[];
  updatedAt: string;
}

export interface AdaptiveWidthOwnershipStore {
  read: () => AdaptiveWidthOwnershipRecord[];
  upsert: (record: Omit<AdaptiveWidthOwnershipRecord, 'updatedAt'>) => void;
  remove: (sessionName: string) => void;
}

export function getAdaptiveWidthOwnershipStorePath(homeDir = homedir()) {
  return join(getWtermHomeDir(homeDir), 'adaptive-width.json');
}

function normalizeRecord(value: unknown): AdaptiveWidthOwnershipRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AdaptiveWidthOwnershipRecord>;
  const cols = Number(record.baseline?.cols);
  const rows = Number(record.baseline?.rows);
  const appliedCols = Number(record.appliedCols);
  const appliedRows = Number(record.appliedRows);
  if (
    typeof record.sessionName !== 'string'
    || !record.sessionName.trim()
    || typeof record.paneId !== 'string'
    || !record.paneId.trim()
    || !Number.isFinite(cols)
    || cols <= 0
    || !Number.isFinite(rows)
    || rows <= 0
    || !Number.isFinite(appliedCols)
    || appliedCols <= 0
    || !Number.isFinite(appliedRows)
    || appliedRows <= 0
  ) {
    return null;
  }
  return {
    sessionName: record.sessionName.trim(),
    paneId: record.paneId.trim(),
    baseline: {
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
    },
    appliedCols: Math.max(1, Math.floor(appliedCols)),
    appliedRows: Math.max(1, Math.floor(appliedRows)),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  };
}

function readStore(storePath: string): AdaptiveWidthOwnershipStoreData {
  if (!existsSync(storePath)) {
    return { schemaVersion: 1, records: [], updatedAt: new Date().toISOString() };
  }
  const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as Partial<AdaptiveWidthOwnershipStoreData>;
  const records = Array.isArray(parsed.records)
    ? parsed.records.map(normalizeRecord).filter((record): record is AdaptiveWidthOwnershipRecord => record !== null)
    : [];
  return {
    schemaVersion: 1,
    records,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function writeStore(storePath: string, records: AdaptiveWidthOwnershipRecord[]) {
  mkdirSync(dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${process.pid}.tmp`;
  const payload: AdaptiveWidthOwnershipStoreData = {
    schemaVersion: 1,
    records,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  renameSync(tempPath, storePath);
}

export function createAdaptiveWidthOwnershipStore(
  storePath = getAdaptiveWidthOwnershipStorePath(),
): AdaptiveWidthOwnershipStore {
  return {
    read: () => readStore(storePath).records,
    upsert: (record) => {
      const nextRecord: AdaptiveWidthOwnershipRecord = {
        ...record,
        updatedAt: new Date().toISOString(),
      };
      const records = readStore(storePath).records.filter((entry) => entry.sessionName !== record.sessionName);
      records.push(nextRecord);
      writeStore(storePath, records);
    },
    remove: (sessionName) => {
      const records = readStore(storePath).records.filter((entry) => entry.sessionName !== sessionName);
      writeStore(storePath, records);
    },
  };
}
