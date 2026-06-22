import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readHttpRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-http-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 1800) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server http route truth gates', () => {
  it('keeps server glue delegating http route handling to dedicated runtime', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalHttpRuntime');
    expect(source).toContain('const terminalHttpRuntime = createTerminalHttpRuntime({');
    expect(source).toContain('terminalHttpRuntime.handleHttpRequest(request, response)');
    expect(source).toContain('daemonRuntimeDebugStore,');
    expect(source).toContain('setDaemonRuntimeDebugEnabled,');
    expect(source).toContain(
      'buildConnectedPayload: (sessionId, requestOrigin) => terminalHttpRuntime.buildConnectedPayload(sessionId, requestOrigin)',
    );
    expect(source).toContain('terminalHttpRuntime.resolveRequestOrigin(request)');
  });

  it('keeps http debug/update implementations out of server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function handleHttpRequest(');
    expect(source).not.toContain('function buildRuntimeHealthSnapshot(');
    expect(source).not.toContain('function buildDebugRuntimeSnapshot(');
    expect(source).not.toContain('function ensureDebugAuthorized(');
    expect(source).not.toContain('function resolveUpdateFilePath(');
    expect(source).not.toContain('function readLatestUpdateManifest(');
  });

  it('keeps health/debug/update routes in dedicated http runtime', () => {
    const source = readHttpRuntimeSource();
    const snapshotBlock = extractBlock(source, 'function buildDebugRuntimeSnapshot(', 2200);
    const block = extractBlock(source, 'function handleHttpRequest(', 8000);

    expect(snapshotBlock).toContain('daemonDebug: deps.daemonRuntimeDebugStore.getSummary()');
    expect(block).toContain("url.pathname === '/health'");
    expect(block).toContain("url.pathname === '/debug/runtime'");
    expect(block).toContain("url.pathname === '/debug/runtime/logs'");
    expect(block).toContain("url.pathname === '/debug/runtime/control'");
    expect(block).toContain('daemonEntries');
    expect(block).toContain('daemonReturned');
    expect(block).toContain('deps.setDaemonRuntimeDebugEnabled(enabled)');
    expect(block).toContain("url.pathname === '/updates/latest.json'");
    expect(block).toContain("url.pathname.startsWith('/updates/')");
  });

  it('does not rewrite apkUrl against the request origin in /updates/latest.json', () => {
    const source = readHttpRuntimeSource();
    const block = extractBlock(source, 'function handleHttpRequest(', 9000);

    // Forward gate: the daemon MUST emit apkUrl exactly as written by the
    // build pipeline. Rewriting it to `${origin}/updates/<file>` pins the
    // download target to whoever requested the manifest (typically the
    // client's loopback), which produces HTTP 404 on real devices.
    expect(block).not.toContain("`${origin}/updates/${basename(apkUrl)}`");
    expect(block).not.toMatch(/manifest\.apkUrl\s*=\s*`\$\{origin\}\/updates\//);
    expect(block).toContain("url.pathname === '/updates/latest.json'");
  });
});
