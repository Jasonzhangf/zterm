import { execFileSync } from 'node:child_process';
import { resolveRexExecutable } from './terminal-backend-selection';
import { normalizeCapturedLineBlock, trimCanonicalBufferWindow } from './canonical-buffer';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';
import type {
  ResolvedTerminalSession,
  RexTerminalSessionTarget,
  TerminalSessionIdentity,
  TerminalSourceAdapter,
  TerminalSourceMirrorSnapshot,
  TerminalSourceSession,
} from './terminal-source-adapter';
import {
  buildRexSessionStableId,
  parseTerminalSessionStableId,
} from './terminal-source-adapter';

export interface RexCommandRunner {
  run: (args: string[]) => string;
}

export interface RexBackendRuntimeOptions {
  executable?: string;
  runner?: RexCommandRunner;
  maxMirrorLines?: number;
  defaultCols?: number;
  defaultRows?: number;
}

interface RexSessionRow {
  session_id: string;
  label: string;
}

interface RexBlockRow {
  block_id: string;
  label: string;
  creator_name?: string;
  flavor?: string;
  host_id?: string;
  placement?: string;
  window_id?: string | null;
}

interface RexWindowView {
  window_id: string;
  label?: string;
  layers?: Array<{ blocks?: RexBlockRow[] | null }> | null;
}

interface RexSessionView {
  session_id?: string | null;
  label?: string;
  windows?: RexWindowView[] | null;
}

interface RexTarget extends RexTerminalSessionTarget {
  sessionLabel: string;
  blockLabel: string;
  instanceId: string;
}

interface RexMetadata {
  cols: number;
  rows: number;
  cwd: string;
}

interface RexFormatResult {
  content?: string;
  id?: unknown;
  total?: unknown;
}

interface RexBlobReadResult {
  id?: unknown;
  data?: unknown;
  total?: unknown;
  eof?: unknown;
}

const REX_API_REVISION = 24;

function createDefaultRunner(executable: string): RexCommandRunner {
  return {
    run(args) {
      return execFileSync(executable, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
      });
    },
  };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Rex ${label} returned invalid JSON: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

function nonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Rex ${label} must be a non-empty string`);
  }
  return value;
}

function positiveSize(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Rex ${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Rex ${label} must be a non-negative integer`);
  }
  return value;
}

function slug(value: string) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
}

function sessionNameForTarget(sessionLabel: string, windowLabel: string, blockLabel: string, blockId: string) {
  const label = [sessionLabel, windowLabel, blockLabel]
    .map(slug)
    .filter(Boolean)
    .join('-') || 'block';
  const blockSuffix = blockId.replace(/^block:/u, '').slice(0, 8);
  return `rex-${label}-${blockSuffix}`;
}

function isTerminalBlock(block: RexBlockRow) {
  return Boolean(block.block_id)
    && (block.creator_name === 'com.superlogical.terminal'
      || (block.flavor || '').startsWith('com.superlogical.terminal.'));
}

export function createRexBackendRuntime(options: RexBackendRuntimeOptions = {}): TerminalSourceAdapter {
  const runner = options.runner || createDefaultRunner(
    options.executable ?? resolveRexExecutable(),
  );
  const maxMirrorLines = Math.max(1, Math.floor(options.maxMirrorLines || 1000));
  const defaultCols = Math.max(1, Math.floor(options.defaultCols || 80));
  const defaultRows = Math.max(1, Math.floor(options.defaultRows || 24));
  const revisions = new Map<string, number>();
  const metadata = new Map<string, RexMetadata>();
  const bindings = new Map<string, RexTerminalSessionTarget>();

  function api<T>(method: string, args: Record<string, unknown> = {}): T {
    return parseJson<T>(runner.run([
      '--autostart=false',
      'api',
      'call',
      method,
      JSON.stringify(args),
    ]), method);
  }

  function readWhoami() {
    const whoami = parseJson<{ instance_id?: unknown; api_revision?: unknown }>(
      runner.run(['whoami', '--json', '--autostart=false']),
      'whoami',
    );
    if (whoami.api_revision !== REX_API_REVISION) {
      throw new Error(`Rex backend supports API revision ${REX_API_REVISION}, received ${
        typeof whoami.api_revision === 'number' ? whoami.api_revision : 'unknown'
      }`);
    }
    return {
      instanceId: nonEmptyString(whoami.instance_id, 'instance_id'),
      apiRevision: whoami.api_revision,
    };
  }

  function blockCall<T>(
    target: Pick<RexTerminalSessionTarget, 'sessionId' | 'blockId'>,
    method: string,
    args: Record<string, unknown> = {},
  ): T {
    return api<T>('block.method', {
      session_id: target.sessionId,
      block_id: target.blockId,
      method,
      args,
    });
  }

  function discoverTargets() {
    const { instanceId } = readWhoami();
    const listedSessions = api<{ sessions?: RexSessionRow[] | null }>('session.list').sessions || [];
    const targets: RexTarget[] = [];
    for (const session of listedSessions) {
      if (!session.session_id) continue;
      const view = api<RexSessionView>('session.view', { session_id: session.session_id });
      const placed = new Map<string, { windowId: string; windowLabel: string }>();
      for (const window of view.windows || []) {
        if (!window.window_id) continue;
        for (const layer of window.layers || []) {
          for (const block of layer.blocks || []) {
            if (block.block_id) {
              placed.set(block.block_id, {
                windowId: window.window_id,
                windowLabel: window.label || window.window_id,
              });
            }
          }
        }
      }
      const listedBlocks = api<{ blocks?: RexBlockRow[] | null }>(
        'session.list_blocks',
        { session_id: session.session_id },
      ).blocks || [];
      for (const block of listedBlocks) {
        if (!block.block_id || !isTerminalBlock(block)) continue;
        const placement = placed.get(block.block_id);
        const windowId = placement?.windowId || block.window_id || 'detached';
        const sessionLabel = view.label || session.label || session.session_id;
        const blockLabel = block.label || block.block_id;
        const stableId = buildRexSessionStableId({
          instanceId,
          sessionId: session.session_id,
          blockId: block.block_id,
        });
        targets.push({
          backend: 'rex',
          instanceId,
          sessionId: session.session_id,
          blockId: block.block_id,
          sessionName: sessionNameForTarget(
            sessionLabel,
            placement?.windowLabel || windowId,
            blockLabel,
            block.block_id,
          ),
          stableId,
          sessionLabel,
          blockLabel,
        });
      }
    }
    return targets;
  }

  function resolve(sessionName: string) {
    const normalized = sessionName.trim();
    const bound = bindings.get(normalized);
    if (bound) {
      const current = discoverTargets().find((candidate) => candidate.stableId === bound.stableId);
      if (current) return current;
      throw new Error(`Rex block identity is no longer present: ${normalized}`);
    }
    const target = discoverTargets().find((candidate) => candidate.sessionName === normalized);
    if (!target) throw new Error(`Rex block not found: ${normalized}`);
    return target;
  }

  function readSnapshot(sessionName: string): Promise<TerminalSourceMirrorSnapshot> {
    const target = resolve(sessionName);
    const size = blockCall<{ columns?: unknown; rows?: unknown }>(target, 'size');
    const cols = positiveSize(size.columns, 'size.columns');
    const rows = positiveSize(size.rows, 'size.rows');
    const formatted = blockCall<RexFormatResult>(target, 'format', {
      format: 'vt',
      trim: false,
      unwrap: false,
      extra_cursor: true,
      extra_keyboard: true,
      max_bytes: 960 * 1024,
    });
    let formattedContent = typeof formatted.content === 'string' ? formatted.content : '';
    if (formatted.id !== undefined) {
      const blobId = nonNegativeInteger(formatted.id, 'format.id');
      const expectedTotal = formatted.total === undefined
        ? null
        : nonNegativeInteger(formatted.total, 'format.total');
      let offset = Buffer.byteLength(formattedContent, 'utf8');
      for (;;) {
        const chunk = blockCall<RexBlobReadResult>(target, 'blob_read', {
          id: blobId,
          offset,
          max_bytes: 960 * 1024,
        });
        if (nonNegativeInteger(chunk.id, 'blob_read.id') !== blobId) {
          throw new Error('Rex blob_read returned a different blob identity');
        }
        if (typeof chunk.data !== 'string') {
          throw new Error('Rex blob_read.data must be a string');
        }
        const total = nonNegativeInteger(chunk.total, 'blob_read.total');
        if (expectedTotal !== null && total !== expectedTotal) {
          throw new Error('Rex blob_read returned a different total size');
        }
        if (typeof chunk.eof !== 'boolean') {
          throw new Error('Rex blob_read.eof must be a boolean');
        }
        formattedContent += chunk.data;
        offset += Buffer.byteLength(chunk.data, 'utf8');
        if (chunk.eof) break;
        if (!chunk.data || offset >= total) {
          throw new Error('Rex blob_read did not make progress toward EOF');
        }
      }
      if (expectedTotal !== null && offset !== expectedTotal) {
        throw new Error('Rex blob_read ended before the declared total size');
      }
    }
    const rawLines = normalizeCapturedLineBlock(formattedContent);
    return canonicalizeCapturedMirrorLines(rawLines, cols).then((canonicalLines) => {
      const trimmed = trimCanonicalBufferWindow(0, canonicalLines, maxMirrorLines);
      const revision = (revisions.get(target.sessionName) || 0) + 1;
      revisions.set(target.sessionName, revision);
      const previous = metadata.get(target.blockId);
      metadata.set(target.blockId, {
        cols,
        rows,
        cwd: previous?.cwd || '',
      });
      const availableEndIndex = trimmed.startIndex + trimmed.lines.length;
      return {
        revision,
        bufferStartIndex: trimmed.startIndex,
        bufferLines: trimmed.lines,
        cols,
        rows,
        cursorKeysApp: false,
        cursor: null,
        lastScrollbackCount: Math.max(0, trimmed.lines.length - rows),
        availableStartIndex: trimmed.startIndex,
        availableEndIndex,
        totalAvailableLines: availableEndIndex,
        visibleTopIndex: Math.max(trimmed.startIndex, availableEndIndex - rows),
        capturedLineCount: rawLines.length,
        canonicalLineCount: canonicalLines.length,
        source: 'rex',
      };
    });
  }

  function listSessions(): TerminalSourceSession[] {
    return discoverTargets().map((target) => {
      const cached = metadata.get(target.blockId);
      return {
        sessionName: target.sessionName,
        paneId: target.blockId,
        stableId: target.stableId,
        workspace: target.sessionLabel,
        title: target.blockLabel,
        cwd: cached?.cwd || '',
        cols: cached?.cols || defaultCols,
        rows: cached?.rows || defaultRows,
      };
    });
  }

  function createSession(input?: { sessionName?: string; cwd?: string; command?: string[] }) {
    const label = slug(input?.sessionName || '') || 'zterm-rex';
    const args = ['--autostart=false', 'session', 'new', label, '--json'];
    if (input?.cwd) args.push('-c', input.cwd);
    if (input?.command?.length) args.push('--', ...input.command);
    const created = parseJson<{ session_id?: unknown }>(runner.run(args), 'session new');
    const sessionId = nonEmptyString(created.session_id, 'session_id');
    const target = discoverTargets().find((candidate) => candidate.sessionId === sessionId);
    if (!target) throw new Error(`Rex created session ${sessionId} has no terminal block`);
    const session = listSessions().find((candidate) => candidate.sessionName === target.sessionName);
    if (!session) throw new Error(`Rex created session ${sessionId} is not listed`);
    return session;
  }

  function writeInput(sessionName: string, input: Buffer | string) {
    const target = resolve(sessionName);
    const data = Buffer.isBuffer(input) ? input.toString('utf8') : input;
    const result = blockCall<{ bytes_written?: unknown }>(target, 'write', { data });
    const expectedBytes = Buffer.byteLength(data, 'utf8');
    if (result.bytes_written !== expectedBytes) {
      throw new Error(`Rex input acknowledgement mismatch: expected ${expectedBytes}, received ${
        typeof result.bytes_written === 'number' ? result.bytes_written : 'unknown'
      }`);
    }
  }

  function resizeSession(sessionName: string, geometry: { cols: number; rows: number }) {
    const target = resolve(sessionName);
    blockCall(target, 'resize', {
      columns: positiveSize(geometry.cols, 'resize.columns'),
      rows: positiveSize(geometry.rows, 'resize.rows'),
    });
  }

  function closeSession(sessionName: string) {
    const target = resolve(sessionName);
    runner.run([
      '--autostart=false',
      'block',
      'close',
      target.blockId,
      '-s',
      target.sessionId,
    ]);
    bindings.delete(sessionName);
    metadata.delete(target.blockId);
    revisions.delete(sessionName);
  }

  function readCurrentPath(sessionName: string) {
    const target = resolve(sessionName);
    const result = blockCall<{ pwd?: unknown }>(target, 'pwd');
    const cwd = typeof result.pwd === 'string' ? result.pwd : '';
    const previous = metadata.get(target.blockId);
    metadata.set(target.blockId, {
      cols: previous?.cols || defaultCols,
      rows: previous?.rows || defaultRows,
      cwd,
    });
    return cwd;
  }

  function readSessionIdentity(sessionName: string): TerminalSessionIdentity {
    const target = resolve(sessionName);
    return {
      backend: 'rex',
      sessionName: target.sessionName,
      stableId: target.stableId,
    };
  }

  function resolveExistingSession(stableId: string): ResolvedTerminalSession | null {
    const parsed = parseTerminalSessionStableId(stableId);
    if (!parsed || parsed.backend !== 'rex') return null;
    const target = discoverTargets().find((candidate) => candidate.stableId === stableId);
    if (!target) return null;
    if (
      target.instanceId !== parsed.instanceId
      || target.sessionId !== parsed.sessionId
      || target.blockId !== parsed.blockId
    ) {
      return null;
    }
    return {
      identity: {
        backend: 'rex',
        sessionName: target.sessionName,
        stableId: target.stableId,
      },
      target: {
        backend: 'rex',
        sessionName: target.sessionName,
        stableId: target.stableId,
        instanceId: target.instanceId,
        sessionId: target.sessionId,
        blockId: target.blockId,
      },
    };
  }

  function bindResolvedSession(session: ResolvedTerminalSession) {
    if (session.target.backend !== 'rex') {
      throw new Error('Rex backend cannot bind a non-Rex target');
    }
    const current = resolveExistingSession(session.target.stableId);
    if (!current || current.target.backend !== 'rex') {
      throw new Error('Rex resolved block is no longer present');
    }
    bindings.set(session.identity.sessionName, current.target);
  }

  return {
    kind: 'rex',
    listSessions,
    createSession,
    readSnapshot,
    writeInput,
    resizeSession,
    supportsSessionRename: false,
    closeSession,
    readCurrentPath,
    readSessionIdentity,
    resolveExistingSession,
    bindResolvedSession,
  };
}
