#!/usr/bin/env tsx

type Command = 'snapshot' | 'logs' | 'enable' | 'disable';

interface CliOptions {
  command: Command;
  host: string;
  port: number;
  token: string;
  sessionId?: string;
  tmuxSessionName?: string;
  scope?: string;
  limit?: number;
  reason?: string;
  pretty: boolean;
}

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

function hasFlag(args: string[], name: string) {
  return args.includes(`--${name}`);
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

function parseCommand(value: string | undefined): Command {
  if (value === 'snapshot' || value === 'logs' || value === 'enable' || value === 'disable') {
    return value;
  }
  fail(`usage: tsx scripts/runtime-debug-remote.ts <snapshot|logs|enable|disable> --host <host> [--port 3333] [--token <token>]`);
}

function parseCli(argv: string[]): CliOptions {
  const command = parseCommand(argv[0]);
  const host = readFlag(argv, 'host')?.trim() || '';
  if (!host) {
    fail('missing --host');
  }

  return {
    command,
    host,
    port: parsePort(readFlag(argv, 'port')),
    token: readFlag(argv, 'token')?.trim() || '',
    sessionId: readFlag(argv, 'sessionId')?.trim() || undefined,
    tmuxSessionName: readFlag(argv, 'tmuxSessionName')?.trim() || undefined,
    scope: readFlag(argv, 'scope')?.trim() || undefined,
    limit: parseLimit(readFlag(argv, 'limit')),
    reason: readFlag(argv, 'reason')?.trim() || 'runtime-debug-remote',
    pretty: !hasFlag(argv, 'no-pretty'),
  };
}

function buildBaseUrl(options: CliOptions) {
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
  const baseUrl = buildBaseUrl(options);

  let url: URL;
  switch (options.command) {
    case 'snapshot':
      url = new URL('/debug/runtime', baseUrl);
      addToken(url, options.token);
      break;
    case 'logs':
      url = new URL('/debug/runtime/logs', baseUrl);
      addToken(url, options.token);
      url.searchParams.set('limit', String(options.limit || 200));
      if (options.sessionId) {
        url.searchParams.set('sessionId', options.sessionId);
      }
      if (options.tmuxSessionName) {
        url.searchParams.set('tmuxSessionName', options.tmuxSessionName);
      }
      if (options.scope) {
        url.searchParams.set('scope', options.scope);
      }
      break;
    case 'enable':
    case 'disable':
      url = new URL('/debug/runtime/control', baseUrl);
      addToken(url, options.token);
      url.searchParams.set('enabled', options.command === 'enable' ? '1' : '0');
      url.searchParams.set('reason', options.reason || 'runtime-debug-remote');
      if (options.sessionId) {
        url.searchParams.set('sessionId', options.sessionId);
      }
      break;
  }

  const payload = await fetchJson(url);
  process.stdout.write(
    options.pretty
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${JSON.stringify(payload)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[runtime-debug-remote] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
