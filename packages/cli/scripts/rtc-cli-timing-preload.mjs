import { closeSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

function normalizedEntry(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function timingScope(argv) {
  const command = argv[0];
  if (command === 'login') return 'login';
  if (command === 'logout') return 'logout';
  if (command === 'slot') return 'slot';
  if (typeof command === 'string' && /^\d+$/.test(command)) return 'numbered';
  return 'other';
}

const entry = normalizedEntry(process.argv[1]);
const expectedEntry = normalizedEntry(process.env.ZTERM_REMOTE_CLI);
const timingDir = process.env.ZTERM_NATIVE_TIMING_DIR;

if (entry && expectedEntry && entry === expectedEntry && timingDir) {
  let fd;
  try {
    mkdirSync(timingDir, { recursive: true, mode: 0o700 });
    fd = openSync(join(timingDir, `cli-native-${process.pid}.jsonl`), 'a', 0o600);
  } catch {
    // Optional timing output must not interrupt the installed CLI.
  }
  if (fd !== undefined) {
    const scope = timingScope(process.argv.slice(2));
    const { installNativeTimingObserver } = await import('./rtc-passive-observer.mjs');
    installNativeTimingObserver({
      resolveFrom: process.argv[1],
      emit(event) {
        if (fd === undefined) return;
        try {
          writeSync(fd, `${JSON.stringify({ ...event, scope })}\n`);
        } catch {
          try { closeSync(fd); } catch { /* optional diagnostic descriptor */ }
          fd = undefined;
        }
      },
    });
  }
}
