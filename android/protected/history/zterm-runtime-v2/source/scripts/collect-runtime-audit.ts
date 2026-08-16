#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { detectRuntimeSequenceAnomalies, parseRuntimeSequenceEntries } from '../src/lib/runtime-debug-sequence';

type CommandOptions = {
  host: string;
  port: number;
  token: string;
  sessionId?: string;
  tmuxSessionName?: string;
  scope?: string;
  limit: number;
  label: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function readFlag(args: string[], name: string) {
  const index = args.findIndex((item) => item === `--${name}`);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function parsePort(value: string | undefined) {
  if (!value) {
    return 3333;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`invalid --port: ${value}`);
  }
  return parsed;
}

function parseLimit(value: string | undefined) {
  if (!value) {
    return 200;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`invalid --limit: ${value}`);
  }
  return parsed;
}

function parseCli(argv: string[]): CommandOptions {
  const host = readFlag(argv, 'host')?.trim() || '';
  if (!host) {
    fail('missing --host');
  }

  return {
    host,
    port: parsePort(readFlag(argv, 'port')),
    token: readFlag(argv, 'token')?.trim() || '',
    sessionId: readFlag(argv, 'sessionId')?.trim() || undefined,
    tmuxSessionName: readFlag(argv, 'tmuxSessionName')?.trim() || undefined,
    scope: readFlag(argv, 'scope')?.trim() || undefined,
    limit: parseLimit(readFlag(argv, 'limit')),
    label: readFlag(argv, 'label')?.trim() || 'manual-capture',
  };
}

function currentDateFolder() {
  return new Date().toISOString().slice(0, 10);
}

function currentTimestampFolder() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function buildBaseUrl(options: CommandOptions) {
  return `http://${options.host}:${options.port}`;
}

function addToken(url: URL, token: string) {
  if (token) {
    url.searchParams.set('token', token);
  }
}

async function fetchJson(url: URL) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    fail(`request failed (${response.status}): ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid json response: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const evidenceDir = join(
    process.cwd(),
    'evidence',
    'runtime-audit',
    currentDateFolder(),
    `${currentTimestampFolder()}-${options.label}`,
  );
  mkdirSync(evidenceDir, { recursive: true });

  const baseUrl = buildBaseUrl(options);
  const snapshotUrl = new URL('/debug/runtime', baseUrl);
  addToken(snapshotUrl, options.token);

  const logsUrl = new URL('/debug/runtime/logs', baseUrl);
  addToken(logsUrl, options.token);
  logsUrl.searchParams.set('limit', String(options.limit));
  if (options.sessionId) {
    logsUrl.searchParams.set('sessionId', options.sessionId);
  }
  if (options.tmuxSessionName) {
    logsUrl.searchParams.set('tmuxSessionName', options.tmuxSessionName);
  }
  if (options.scope) {
    logsUrl.searchParams.set('scope', options.scope);
  }

  const [snapshot, logs] = await Promise.all([
    fetchJson(snapshotUrl),
    fetchJson(logsUrl),
  ]);

  writeFileSync(join(evidenceDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(evidenceDir, 'logs.json'), `${JSON.stringify(logs, null, 2)}\n`);

  const entries = parseRuntimeSequenceEntries(Array.isArray(logs?.entries) ? logs.entries : []);
  const anomalies = detectRuntimeSequenceAnomalies(entries);
  const analysis = {
    generatedAt: new Date().toISOString(),
    host: options.host,
    port: options.port,
    sessionId: options.sessionId ?? null,
    tmuxSessionName: options.tmuxSessionName ?? null,
    scope: options.scope ?? null,
    eventCount: entries.length,
    anomalyCount: anomalies.length,
    anomalies,
  };
  writeFileSync(join(evidenceDir, 'sequence-analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    evidenceDir,
    snapshotPath: join(evidenceDir, 'snapshot.json'),
    logsPath: join(evidenceDir, 'logs.json'),
    sequenceAnalysisPath: join(evidenceDir, 'sequence-analysis.json'),
    anomalyCount: anomalies.length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[collect-runtime-audit] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
