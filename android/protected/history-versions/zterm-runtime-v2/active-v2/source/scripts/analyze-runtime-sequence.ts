import { readFileSync } from 'fs';
import { resolve } from 'path';
import { detectRuntimeSequenceAnomalies, parseRuntimeSequenceEntries } from '../src/lib/runtime-debug-sequence';

interface ParsedArgs {
  logPath: string;
  sessionId: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let logPath = 'evidence/runtime-audit/2026-04-26/logs-after-apk.json';
  let sessionId: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length).trim() || null;
      continue;
    }
    if (!arg.startsWith('--')) {
      logPath = arg;
    }
  }

  return {
    logPath: resolve(process.cwd(), logPath),
    sessionId,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(args.logPath, 'utf8')) as {
    entries?: Array<{ seq?: number; ts?: string; scope?: string; payload?: string | null }>;
  };
  const allEvents = parseRuntimeSequenceEntries(raw.entries || []);
  const events = args.sessionId
    ? allEvents.filter((event) => event.sessionId === args.sessionId)
    : allEvents;
  const anomalies = detectRuntimeSequenceAnomalies(events);

  process.stdout.write(`${JSON.stringify({
    logPath: args.logPath,
    sessionId: args.sessionId,
    eventCount: events.length,
    anomalyCount: anomalies.length,
    anomalies,
  }, null, 2)}\n`);
}

main();
