import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRexBackendRuntime, type RexCommandRunner } from './rex-backend';
import {
  buildRexSessionStableId,
  type TerminalSourceAdapter,
} from './terminal-source-adapter';

const instanceId = 'rex-instance-a';
const sessionId = 'session:fixture-a';
const blockA = 'block:fixture-a';
const blockB = 'block:fixture-b';

describe('Rex default runner executable selection', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function executable(name: string, body: string) {
    const root = mkdtempSync(join(tmpdir(), 'rex-runner-')); roots.push(root);
    const file = join(root, name); mkdirSync(root, { recursive: true });
    writeFileSync(file, '#!/bin/sh\n' + body + '\n'); chmodSync(file, 0o755);
    return { file, root };
  }
  it('uses shared resolver trimming and preserves explicit options priority', () => {
    const env = executable('env tool', 'echo env-failure >&2; exit 7');
    const option = executable('option tool', 'echo option-failure >&2; exit 8');
    vi.stubEnv('ZTERM_REX_EXE', '  ' + env.file + '  ');
    expect(() => createRexBackendRuntime().listSessions()).toThrow('env-failure');
    expect(() => createRexBackendRuntime({ executable: option.file }).listSessions()).toThrow('option-failure');
    expect(() => createRexBackendRuntime({ executable: join(option.root, 'missing') }).listSessions()).toThrow('ENOENT');
  });
  it('uses PATH without overriding a selected executable API failure', () => {
    const f = executable('rex', 'echo \'{"instance_id":"fixture","api_revision":23}\''); 
    vi.stubEnv('ZTERM_REX_EXE', '  '); vi.stubEnv('PATH', f.root);
    expect(() => createRexBackendRuntime().listSessions()).toThrow('supports API revision 24, received 23');
  });
});

type RexBlockFixture = {
  block_id: string;
  label: string;
  creator_name: string;
  flavor: string;
  host_id: string;
  placement: 'placed' | 'detached';
  window_id?: string;
};

class FixtureRunner implements RexCommandRunner {
  blocks: RexBlockFixture[] = [];
  output = 'REX_OUTPUT\n';
  maxFormatChunkBytes = Number.POSITIVE_INFINITY;
  readonly writes: Array<{ blockId: string; data: string }> = [];
  readonly blobReads: Array<{ blockId: string; offset: number; maxBytes: number }> = [];

  constructor() {
    this.resetBlock(blockA, 'shell');
  }

  resetBlock(blockId: string, label = 'shell') {
    this.blocks = [{
      block_id: blockId,
      label,
      creator_name: 'com.superlogical.terminal',
      flavor: 'com.superlogical.terminal.shell',
      host_id: 'host-a',
      placement: 'placed',
      window_id: 'window:fixture-a',
    }];
  }

  run(args: string[]): string {
    if (args.includes('whoami')) {
      return JSON.stringify({
        instance_id: instanceId,
        api_revision: 24,
        session_id: sessionId,
      });
    }
    const methodIndex = args.indexOf('call') + 1;
    const method = args[methodIndex];
    const request = JSON.parse(args[methodIndex + 1] || '{}') as {
      session_id?: string;
      block_id?: string;
      method?: string;
      args?: Record<string, unknown>;
    };
    if (method === 'session.list') {
      return JSON.stringify({ sessions: [{ session_id: sessionId, label: 'fixture' }] });
    }
    if (method === 'session.view') {
      return JSON.stringify({
        session_id: sessionId,
        label: 'fixture',
        windows: [{
          window_id: 'window:fixture-a',
          label: 'window',
          layers: [{ blocks: this.blocks.filter((block) => block.placement === 'placed') }],
        }],
      });
    }
    if (method === 'session.list_blocks') {
      return JSON.stringify({ blocks: this.blocks });
    }
    if (method === 'block.method') {
      const blockId = request.block_id || '';
      if (!this.blocks.some((block) => block.block_id === blockId)) {
        throw new Error('not_found');
      }
      if (request.method === 'size') {
        return JSON.stringify({ columns: 80, rows: 24 });
      }
      if (request.method === 'pwd') {
        return JSON.stringify({ pwd: '/tmp/fixture' });
      }
      if (request.method === 'format') {
        const encoded = Buffer.from(this.output, 'utf8');
        if (encoded.byteLength <= this.maxFormatChunkBytes) {
          return JSON.stringify({ content: this.output, eof: true });
        }
        return JSON.stringify({
          content: encoded.subarray(0, this.maxFormatChunkBytes).toString('utf8'),
          id: 7,
          total: encoded.byteLength,
          eof: false,
        });
      }
      if (request.method === 'blob_read') {
        const id = Number(request.args?.id);
        const offset = Number(request.args?.offset || 0);
        const maxBytes = Math.min(
          Number(request.args?.max_bytes || 48 * 1024),
          this.maxFormatChunkBytes,
        );
        if (id !== 7) throw new Error('unexpected blob id');
        const encoded = Buffer.from(this.output, 'utf8');
        const data = encoded.subarray(offset, offset + maxBytes).toString('utf8');
        this.blobReads.push({ blockId, offset, maxBytes });
        return JSON.stringify({
          id,
          data,
          total: encoded.byteLength,
          eof: offset + Buffer.byteLength(data, 'utf8') >= encoded.byteLength,
        });
      }
      if (request.method === 'write') {
        this.writes.push({ blockId, data: String(request.args?.data || '') });
        return JSON.stringify({ bytes_written: Buffer.byteLength(String(request.args?.data || '')) });
      }
      if (request.method === 'resize') {
        return '{}';
      }
    }
    throw new Error(`unexpected Rex command: ${args.join(' ')}`);
  }
}

let adapter: TerminalSourceAdapter;

describe('Rex daemon source adapter', () => {
  it('discovers terminal blocks with instance/session/block identity and an exact session name', () => {
    const runner = new FixtureRunner();
    adapter = createAdapter(runner);
    const sessions = adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.stableId).toBe(buildRexSessionStableId({
      instanceId,
      sessionId,
      blockId: blockA,
    }));
    expect(adapter.readSessionIdentity?.(sessions[0]!.sessionName)).toEqual({
      backend: 'rex',
      sessionName: sessions[0]!.sessionName,
      stableId: sessions[0]!.stableId,
    });
  });

  it('resolves only the exact current instance, session, block, and name', () => {
    const runner = new FixtureRunner();
    adapter = createAdapter(runner);
    const session = adapter.listSessions()[0]!;
    const stableId = session.stableId!;
    expect(adapter.resolveExistingSession?.(stableId)).toEqual({
      identity: { backend: 'rex', sessionName: session.sessionName, stableId },
      target: {
        backend: 'rex',
        sessionName: session.sessionName,
        stableId,
        instanceId,
        sessionId,
        blockId: blockA,
      },
    });

    runner.resetBlock(blockB, 'shell');
    expect(adapter.resolveExistingSession?.(stableId)).toBeNull();
    const recreated = adapter.listSessions()[0]!;
    expect(recreated.stableId).not.toBe(stableId);
  });

  it('writes input to the selected block without sibling routing', () => {
    const runner = new FixtureRunner();
    runner.blocks = [
      runner.blocks[0]!,
      {
        block_id: blockB,
        label: 'sibling',
        creator_name: 'com.superlogical.terminal',
        flavor: 'com.superlogical.terminal.shell',
        host_id: 'host-a',
        placement: 'placed',
        window_id: 'window:fixture-a',
      },
    ];
    adapter = createAdapter(runner);
    const first = adapter.listSessions().find((session) => session.paneId === blockA)!;
    adapter.writeInput(first.sessionName, 'printf TARGET_A_ONLY');
    adapter.writeInput(first.sessionName, '\r');
    expect(runner.writes).toEqual([
      { blockId: blockA, data: 'printf TARGET_A_ONLY' },
      { blockId: blockA, data: '\r' },
    ]);
  });

  it('reads a paginated Rex snapshot through blob_read without dropping bytes', async () => {
    const runner = new FixtureRunner();
    runner.output = '0123456789abcdefghij\n';
    runner.maxFormatChunkBytes = 5;
    adapter = createAdapter(runner);
    const session = adapter.listSessions()[0]!;

    const snapshot = await adapter.readSnapshot(session.sessionName);

    expect(snapshot.source).toBe('rex');
    expect(runner.blobReads.map((read) => read.offset)).toEqual([5, 10, 15, 20]);
    expect(snapshot.bufferLines.map((row) => row
      .map((cell) => String.fromCodePoint(cell.char))
      .join('')
      .trimEnd())).toContain('0123456789abcdefghij');
  });

  it('binds the same live identity for reconnect and invalidates a deleted block', () => {
    const runner = new FixtureRunner();
    adapter = createAdapter(runner);
    const session = adapter.listSessions()[0]!;
    const resolved = adapter.resolveExistingSession!(session.stableId!);
    expect(resolved).not.toBeNull();

    adapter.bindResolvedSession!(resolved!);
    expect(adapter.resolveExistingSession!(session.stableId!)).toEqual(resolved);
    expect(adapter.readSessionIdentity!(session.sessionName)).toEqual(resolved!.identity);

    runner.blocks = [];
    expect(adapter.resolveExistingSession!(session.stableId!)).toBeNull();
    expect(() => adapter.readSessionIdentity!(session.sessionName)).toThrow(
      'Rex block identity is no longer present',
    );

    runner.resetBlock(blockB, 'shell');
    const recreated = adapter.listSessions()[0]!;
    expect(recreated.stableId).toBe(buildRexSessionStableId({
      instanceId,
      sessionId,
      blockId: blockB,
    }));
    expect(adapter.resolveExistingSession!(session.stableId!)).toBeNull();
    expect(() => adapter.readSessionIdentity!(recreated.sessionName)).toThrow(
      'Rex block identity is no longer present',
    );
  });

  it('requires Rex API revision 24', () => {
    const runner = new FixtureRunner();
    const originalRun = runner.run.bind(runner);
    runner.run = (args) => {
      if (args.includes('whoami')) {
        return JSON.stringify({ instance_id: instanceId, api_revision: 23 });
      }
      return originalRun(args);
    };
    adapter = createAdapter(runner);
    expect(() => adapter.listSessions()).toThrow('supports API revision 24, received 23');
  });
});

function createAdapter(runner: RexCommandRunner): TerminalSourceAdapter {
  return createRexBackendRuntime({ runner, maxMirrorLines: 1000 });
}
