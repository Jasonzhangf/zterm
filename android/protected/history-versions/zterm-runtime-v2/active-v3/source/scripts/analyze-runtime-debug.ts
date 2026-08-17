import { readFileSync } from 'fs';
import { resolve } from 'path';

interface ParsedArgs {
  logPath: string;
  sessionFilter: string | null;
  limit: number;
}

interface TimelineEntry {
  timestamp: string;
  category: 'client-debug' | 'daemon-runtime' | 'mirror' | 'other';
  sessionId: string | null;
  text: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let logPath = 'evidence/daemon-mirror/2026-04-22/current-daemon.log';
  let sessionFilter: string | null = null;
  let limit = 120;

  for (const arg of argv) {
    if (arg.startsWith('--session=')) {
      sessionFilter = arg.slice('--session='.length).trim() || null;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const next = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(next) && next > 0) {
        limit = next;
      }
      continue;
    }
    if (!arg.startsWith('--')) {
      logPath = arg;
    }
  }

  return {
    logPath: resolve(process.cwd(), logPath),
    sessionFilter,
    limit,
  };
}

function parseLine(line: string): TimelineEntry | null {
  const timestampMatch = line.match(/^\[(?<ts>[^\]]+)\]\s+(?<rest>.*)$/u);
  if (!timestampMatch?.groups) {
    return null;
  }

  const timestamp = timestampMatch.groups.ts;
  const rest = timestampMatch.groups.rest;
  const sessionIdMatch = rest.match(/\bsession=([A-Za-z0-9-]+)/u);
  const sessionId = sessionIdMatch?.[1] || null;

  let category: TimelineEntry['category'] = 'other';
  if (rest.includes('[client-debug')) {
    category = 'client-debug';
  } else if (rest.includes('[daemon-runtime:')) {
    category = 'daemon-runtime';
  } else if (rest.includes('[mirror:')) {
    category = 'mirror';
  }

  return {
    timestamp,
    category,
    sessionId,
    text: line,
  };
}

function printSummary(entries: TimelineEntry[]) {
  const counts = {
    clientDebug: entries.filter((entry) => entry.category === 'client-debug').length,
    daemonRuntime: entries.filter((entry) => entry.category === 'daemon-runtime').length,
    mirror: entries.filter((entry) => entry.category === 'mirror').length,
    other: entries.filter((entry) => entry.category === 'other').length,
  };

  const sessions = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.sessionId) {
      continue;
    }
    sessions.set(entry.sessionId, (sessions.get(entry.sessionId) || 0) + 1);
  }

  console.log(JSON.stringify({
    totalLines: entries.length,
    counts,
    sessions: [...sessions.entries()].map(([sessionId, lines]) => ({ sessionId, lines })),
  }, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = readFileSync(args.logPath, 'utf8').split('\n').filter(Boolean);
  const parsed = lines.map(parseLine).filter((entry): entry is TimelineEntry => Boolean(entry));
  const sessionFilter = args.sessionFilter;
  const filtered = sessionFilter
    ? parsed.filter((entry) => entry.sessionId === sessionFilter || entry.text.includes(sessionFilter))
    : parsed;

  printSummary(filtered);
  console.log('\n--- recent timeline ---');
  for (const entry of filtered.slice(-args.limit)) {
    console.log(entry.text);
  }
}

main();
