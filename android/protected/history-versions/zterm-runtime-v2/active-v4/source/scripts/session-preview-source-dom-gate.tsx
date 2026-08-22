import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { WebSocket } from 'ws';
import type {
  BridgeClientMessage,
  BridgeServerMessage,
  BufferHeadPayload,
  BufferSyncRequestPayload,
  TerminalBufferPayload,
} from '@zterm/shared';
import { applyBufferSyncToSessionBuffer, cellsToLine } from '../src/lib/terminal-buffer';
import { createSessionRenderBufferStore } from '../src/lib/session-render-buffer-store';
import type { Session, SessionBufferState, SessionRenderBufferSnapshot } from '../src/lib/types';
import { TerminalPreviewGrid } from '../src/components/terminal/TerminalPreviewGrid';
import { TerminalStageShell } from '../src/pages/TerminalPageStageShell';

const ROOT = resolve(import.meta.dirname, '..');
const SESSION_COUNT = 6;
const CACHE_LINES = 500;
const SESSION_PREFIX = 'zterm-preview-gate';
const MAX_PREVIEW_DOM_NODE_COUNT = 8_000;

function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function runTmux(args: string[], operation: string, allowFailure = false) {
  const result = spawnSync('tmux', args, { encoding: 'utf8', timeout: 8_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`${operation} failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result;
}

function tmuxSessionExists(sessionName: string) {
  return runTmux(['has-session', '-t', sessionName], 'tmux has-session', true).status === 0;
}

function sendTmuxCommand(sessionName: string, command: string) {
  runTmux(['send-keys', '-t', sessionName, '-l', command], `tmux send command ${sessionName}`);
  runTmux(['send-keys', '-t', sessionName, 'Enter'], `tmux execute command ${sessionName}`);
}

function captureTmux(sessionName: string) {
  return runTmux(
    ['capture-pane', '-p', '-J', '-t', sessionName, '-S', '-120'],
    `tmux capture ${sessionName}`,
  ).stdout;
}

function rawText(raw: WebSocket.RawData) {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return raw.toString('utf8');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      promise.finally(() => clearTimeout(timer)).catch(() => undefined);
    }),
  ]);
}

class PreviewProtocolClient {
  private controlSocket: WebSocket | null = null;
  private sessionSocket: WebSocket | null = null;
  private connected = false;
  private lastHead: BufferHeadPayload | null = null;
  private buffer: SessionBufferState | undefined;
  private bufferSyncCount = 0;
  private receivedBytes = 0;
  private sessionSocketOpenCount = 0;
  private fatalError: Error | null = null;

  constructor(
    readonly sessionName: string,
    readonly sessionId: string,
    private readonly wsUrl: string,
    private readonly token: string,
  ) {}

  private transportUrl(role: 'control' | 'session') {
    const url = new URL(this.wsUrl);
    url.searchParams.set('ztermTransport', role);
    if (this.token) url.searchParams.set('token', this.token);
    return url.toString();
  }

  private send(message: BridgeClientMessage) {
    if (!this.sessionSocket || this.sessionSocket.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.sessionName}: session socket is not open`);
    }
    this.sessionSocket.send(JSON.stringify(message));
  }

  async connect() {
    const openRequestId = `preview-gate-${this.sessionId}-${Date.now()}`;
    const ticket = await withTimeout(new Promise<Extract<BridgeServerMessage, { type: 'session-ticket' }>['payload']>(
      (resolveTicket, reject) => {
        const socket = new WebSocket(this.transportUrl('control'));
        this.controlSocket = socket;
        socket.once('open', () => socket.send(JSON.stringify({
          type: 'session-open',
          payload: {
            openRequestId,
            sessionName: this.sessionName,
            cols: 120,
            rows: 40,
            widthMode: 'mirror-fixed',
          },
        } satisfies BridgeClientMessage)));
        socket.on('message', (raw) => {
          const message = JSON.parse(rawText(raw)) as BridgeServerMessage;
          if (message.type === 'session-ticket' && message.payload.openRequestId === openRequestId) {
            resolveTicket(message.payload);
          } else if (message.type === 'session-open-failed' || message.type === 'error') {
            reject(new Error(`${this.sessionName}: ${message.payload.message}`));
          }
        });
        socket.once('error', reject);
      },
    ), 8_000, `${this.sessionName} ticket`);

    await withTimeout(new Promise<void>((resolveConnected, reject) => {
      const socket = new WebSocket(this.transportUrl('session'));
      this.sessionSocket = socket;
      socket.once('open', () => {
        this.sessionSocketOpenCount += 1;
        socket.send(JSON.stringify({
          type: 'connect',
          payload: {
            openRequestId: ticket.openRequestId,
            sessionTransportToken: ticket.sessionTransportToken,
            sessionName: ticket.sessionName,
            cols: 120,
            rows: 40,
            widthMode: 'mirror-fixed',
          },
        } satisfies BridgeClientMessage));
      });
      socket.on('message', (raw) => {
        this.receivedBytes += Buffer.byteLength(rawText(raw));
        const message = JSON.parse(rawText(raw)) as BridgeServerMessage;
        if (message.type === 'connected') {
          this.connected = true;
          resolveConnected();
          return;
        }
        if (message.type === 'buffer-head') {
          this.lastHead = message.payload;
          return;
        }
        if (message.type === 'buffer-sync') {
          this.buffer = applyBufferSyncToSessionBuffer(this.buffer, message.payload as TerminalBufferPayload, CACHE_LINES);
          this.bufferSyncCount += 1;
          return;
        }
        if (message.type === 'error') {
          this.fatalError = new Error(`${this.sessionName}: ${message.payload.message}`);
        }
      });
      socket.once('error', reject);
    }), 10_000, `${this.sessionName} connect`);

    this.send({ type: 'body-subscription', payload: { version: 1, subscribed: true } });
    this.send({ type: 'buffer-head-request' });
    await this.waitFor(() => this.lastHead !== null, 8_000, 'head');
    this.requestCurrentRange();
    await this.waitFor(() => Boolean(this.buffer), 8_000, 'initial body');
  }

  requestCurrentRange() {
    const buffer = this.buffer;
    const latestEndIndex = Math.max(0, this.lastHead?.latestEndIndex || buffer?.bufferTailEndIndex || 0);
    const availableStartIndex = Math.max(0, this.lastHead?.availableStartIndex || buffer?.bufferHeadStartIndex || 0);
    const payload: BufferSyncRequestPayload = {
      knownRevision: buffer?.revision || 0,
      localStartIndex: buffer?.startIndex || 0,
      localEndIndex: buffer?.endIndex || 0,
      requestStartIndex: Math.max(availableStartIndex, latestEndIndex - 120),
      requestEndIndex: latestEndIndex,
      targetHeadRevision: this.lastHead?.revision,
    };
    this.send({ type: 'buffer-sync-request', payload });
  }

  async waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.fatalError) throw this.fatalError;
      if (predicate()) return;
      await sleep(25);
    }
    throw new Error(`${this.sessionName}: ${label} timed out`);
  }

  text() {
    return (this.buffer?.lines || []).map(cellsToLine).join('\n');
  }

  renderSnapshot(): SessionRenderBufferSnapshot {
    if (!this.buffer) throw new Error(`${this.sessionName}: missing client sparse buffer`);
    return {
      ...this.buffer,
      daemonHeadRevision: this.lastHead?.revision || this.buffer.revision,
      daemonHeadEndIndex: this.lastHead?.latestEndIndex || this.buffer.bufferTailEndIndex,
    };
  }

  metrics() {
    return {
      connected: this.connected,
      bufferSyncCount: this.bufferSyncCount,
      receivedBytes: this.receivedBytes,
      sessionSocketOpenCount: this.sessionSocketOpenCount,
      revision: this.buffer?.revision || 0,
    };
  }

  async close() {
    for (const socket of [this.sessionSocket, this.controlSocket]) {
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    }
    await sleep(50);
  }
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const globals = {
    React,
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return dom;
}

async function main() {
  const wsUrl = process.env.ZTERM_PREVIEW_GATE_WS_URL || 'ws://127.0.0.1:3333/ws';
  const token = process.env.ZTERM_PREVIEW_GATE_TOKEN || '';
  const gateStartedAt = performance.now();
  const gateCpuStartedAt = process.cpuUsage();
  const healthUrl = new URL(wsUrl);
  healthUrl.protocol = healthUrl.protocol === 'wss:' ? 'https:' : 'http:';
  healthUrl.pathname = '/health';
  healthUrl.search = '';
  const readHealth = async () => {
    const response = await fetch(healthUrl);
    if (!response.ok) throw new Error(`daemon health failed: HTTP ${response.status}`);
    return response.json() as Promise<{
      sessions: { total: number; attached: number; ready: number };
      mirrors: { total: number; ready: number; subscribers: number };
    }>;
  };
  const baselineHealth = await readHealth();
  const runMarker = `ZPREVIEW-${Date.now()}`;
  const sessionNames = Array.from({ length: SESSION_COUNT }, (_, index) => `${SESSION_PREFIX}-${index + 1}`);
  const createdSessions: string[] = [];
  const clients: PreviewProtocolClient[] = [];

  try {
    for (const sessionName of sessionNames) {
      if (!tmuxSessionExists(sessionName)) {
        runTmux(['new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40'], `create ${sessionName}`);
        createdSessions.push(sessionName);
      }
    }

    for (let index = 0; index < sessionNames.length; index += 1) {
      const client = new PreviewProtocolClient(sessionNames[index], `preview-gate-${index + 1}`, wsUrl, token);
      await client.connect();
      clients.push(client);
    }

    const expectedBySession = new Map<string, string[]>();
    for (let index = 0; index < sessionNames.length; index += 1) {
      const sessionName = sessionNames[index];
      const prefix = `${runMarker}-S${index + 1}`;
      const expected = [`${prefix}-HEAD`, `${prefix}-TUI`, `${prefix}-INPUT`];
      expectedBySession.set(sessionName, expected);
      sendTmuxCommand(
        sessionName,
        `i=0; while [ $i -lt 44 ]; do printf '\\n'; i=$((i+1)); done; printf '${prefix}-OLD\\r${expected.join('\\n')}\\n'`,
      );
    }

    await Promise.all(clients.map(async (client) => {
      const expected = expectedBySession.get(client.sessionName) || [];
      await client.waitFor(() => expected.every((marker) => client.text().includes(marker)), 12_000, 'marker body');
      client.requestCurrentRange();
      await client.waitFor(() => expected.every((marker) => client.text().includes(marker)), 4_000, 'reconciled body');
    }));

    const renderStore = createSessionRenderBufferStore();
    let renderStorePublishCount = 0;
    const sessions = clients.map((client, index) => {
      const buffer = client.renderSnapshot();
      if (renderStore.setBuffer(client.sessionId, buffer)) {
        renderStorePublishCount += 1;
      }
      return {
        id: client.sessionId,
        hostId: 'preview-gate-local',
        connectionName: 'preview-gate-local',
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: client.sessionName,
        title: client.sessionName,
        ws: null,
        state: 'connected',
        hasUnread: false,
        buffer,
        createdAt: index + 1,
      } as Session;
    });

    const dom = installDom();
    const renderStartedAt = performance.now();
    const renderCpuStartedAt = process.cpuUsage();
    const view = render(
      <div style={{ width: '720px', height: '960px' }}>
        <TerminalPreviewGrid
          sessions={sessions}
          sessionBufferStore={renderStore}
          landscape={false}
          fontSize={10}
          onActivateSession={() => undefined}
          onClose={() => undefined}
        />
      </div>,
    );

    const initialRenderMs = performance.now() - renderStartedAt;
    const convergenceStartedAt = performance.now();
    const comparisons = await Promise.all(clients.map(async (client, index) => {
      const expected = expectedBySession.get(client.sessionName) || [];
      const tmuxSource = captureTmux(client.sessionName);
      const tile = view.getByTestId(`terminal-preview-tile-${client.sessionId}`);
      await waitFor(() => {
        const text = Array.from(tile.querySelectorAll<HTMLElement>('[data-terminal-row="true"]'))
          .map((row) => row.dataset.terminalRowText || '')
          .join('\n');
        if (!expected.every((marker) => text.includes(marker))) throw new Error('preview DOM has not converged');
      }, { timeout: 4_000 });
      const previewDom = Array.from(tile.querySelectorAll<HTMLElement>('[data-terminal-row="true"]'))
        .map((row) => row.dataset.terminalRowText || '')
        .join('\n');
      const foreignMarkers = clients
        .filter((_, otherIndex) => otherIndex !== index)
        .flatMap((other) => expectedBySession.get(other.sessionName) || []);
      const checks = {
        tmuxSource: expected.every((marker) => tmuxSource.includes(marker)),
        daemonToClientSparse: expected.every((marker) => client.text().includes(marker)),
        clientSparseToPreviewDom: expected.every((marker) => previewDom.includes(marker)),
        crossSessionIsolation: foreignMarkers.every((marker) => !previewDom.includes(marker)),
        singlePhysicalSessionSocket: client.metrics().sessionSocketOpenCount === 1,
      };
      if (Object.values(checks).some((value) => !value)) {
        throw new Error(`${client.sessionName}: parity failed ${JSON.stringify(checks)}`);
      }
      return {
        sessionName: client.sessionName,
        sessionId: client.sessionId,
        expected,
        checks,
        metrics: client.metrics(),
        previewRowCount: tile.querySelectorAll('[data-terminal-row="true"]').length,
      };
    }));
    const convergenceMs = performance.now() - convergenceStartedAt;
    const renderCpuUsage = process.cpuUsage(renderCpuStartedAt);
    const previewGrid = view.getByTestId('terminal-preview-grid');
    const previewLayout = {
      columns: previewGrid.getAttribute('data-columns'),
      rows: previewGrid.getAttribute('data-rows'),
      domNodeCount: view.container.querySelectorAll('*').length,
    };
    if (previewLayout.domNodeCount > MAX_PREVIEW_DOM_NODE_COUNT) {
      throw new Error(
        `preview DOM budget exceeded: nodes=${previewLayout.domNodeCount} max=${MAX_PREVIEW_DOM_NODE_COUNT}`,
      );
    }

    const shellTargetIndex = 1;
    const shellTargetClient = clients[shellTargetIndex];
    const shellTargetSession = sessions[shellTargetIndex];
    const shellLiveMarker = `${runMarker}-S${shellTargetIndex + 1}-SHELL-LIVE`;
    view.rerender(
      <div style={{ width: '720px', height: '960px' }}>
        <TerminalStageShell
          interactiveSession={shellTargetSession}
          sessionBufferStore={renderStore}
          renderedPaneSessions={[shellTargetSession]}
          visiblePaneEntries={[]}
          splitVisible={false}
          activePaneId="pane-main"
          terminalChromeBottomPx={0}
          terminalKeyboardRequested={false}
          isAndroid
          handleTerminalViewportChange={() => undefined}
          handleSwipeTab={() => undefined}
          handleActiveTerminalActivateInput={() => undefined}
          focusNonce={0}
          terminalFontSize={10}
          terminalThemeId="default"
          terminalWidthMode="mirror-fixed"
          absoluteLineNumbersVisible={false}
          copySelection={{
            active: false,
            sessionId: null,
            startRowIndex: null,
            endRowIndex: null,
            menu: null,
          }}
          onLongPressRow={() => undefined}
        />
      </div>,
    );
    sendTmuxCommand(shellTargetClient.sessionName, `printf '${shellLiveMarker}\\n'`);
    await shellTargetClient.waitFor(
      () => shellTargetClient.text().includes(shellLiveMarker),
      8_000,
      'preview-to-shell live marker',
    );
    shellTargetClient.requestCurrentRange();
    await act(async () => {
      renderStore.setBuffer(shellTargetClient.sessionId, shellTargetClient.renderSnapshot());
      await sleep(0);
    });
    let shellDom = '';
    await waitFor(() => {
      const shell = view.getByTestId('terminal-pane-shell');
      shellDom = Array.from(shell.querySelectorAll<HTMLElement>('[data-terminal-row="true"]'))
        .map((row) => row.dataset.terminalRowText || '')
        .join('\n');
      if (!shellDom.includes(shellLiveMarker)) {
        throw new Error('real shell DOM has not continued from preview render truth');
      }
    }, { timeout: 4_000 });
    const previewToShell = {
      selectedSessionId: shellTargetClient.sessionId,
      marker: shellLiveMarker,
      shellDomMatched: shellDom.includes(shellLiveMarker),
      staleSessionExcluded: !(expectedBySession.get(clients[0].sessionName) || [])
        .some((marker) => shellDom.includes(marker)),
      singlePhysicalSessionSocket: shellTargetClient.metrics().sessionSocketOpenCount === 1,
    };
    if (Object.values(previewToShell).some((value) => value === false)) {
      throw new Error(`preview-to-shell continuation failed ${JSON.stringify(previewToShell)}`);
    }

    const previewOpenHealth = await readHealth();
    if (previewOpenHealth.mirrors.subscribers !== baselineHealth.mirrors.subscribers + SESSION_COUNT) {
      throw new Error(
        `preview subscriber count mismatch: baseline=${baselineHealth.mirrors.subscribers} open=${previewOpenHealth.mirrors.subscribers}`,
      );
    }
    await Promise.all(clients.map((client) => client.close()));
    await sleep(300);
    const previewClosedHealth = await readHealth();
    if (previewClosedHealth.mirrors.subscribers !== baselineHealth.mirrors.subscribers) {
      throw new Error(
        `preview subscribers leaked after close: baseline=${baselineHealth.mirrors.subscribers} closed=${previewClosedHealth.mirrors.subscribers}`,
      );
    }

    const result = {
      ok: true,
      runMarker,
      wsUrl,
      sessions: comparisons,
      preview: {
        selectedCount: sessions.length,
        ...previewLayout,
        maxDomNodeCount: MAX_PREVIEW_DOM_NODE_COUNT,
        transportBytes: comparisons.reduce((total, item) => total + item.metrics.receivedBytes, 0),
        localRenderPerformance: {
          initialRenderMs: Math.round(initialRenderMs),
          convergenceMs: Math.round(convergenceMs),
          totalGateMs: Math.round(performance.now() - gateStartedAt),
          cpuUserMicros: renderCpuUsage.user,
          cpuSystemMicros: renderCpuUsage.system,
          renderStorePublishCount,
          totalBufferSyncCount: comparisons.reduce((total, item) => total + item.metrics.bufferSyncCount, 0),
          averagePreviewRowsPerTile: Math.round(
            comparisons.reduce((total, item) => total + item.previewRowCount, 0) / comparisons.length,
          ),
        },
      },
      subscriptionLifecycle: {
        baseline: baselineHealth,
        previewOpen: previewOpenHealth,
        previewClosed: previewClosedHealth,
        exactSixAdded: true,
        restoredAfterClose: true,
      },
      previewToShell,
      lifecycle: {
        createdSessions,
        reusedSessions: sessionNames.filter((name) => !createdSessions.includes(name)),
        cleanupPolicy: 'only explicitly created gate sessions are killed',
      },
      processCpuUsage: process.cpuUsage(gateCpuStartedAt),
    };
    const date = new Date().toISOString().slice(0, 10);
    const evidenceDir = resolve(ROOT, 'evidence', 'session-preview', date);
    mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = resolve(evidenceDir, 'source-dom-gate.json');
    writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...result, evidencePath }, null, 2)}\n`);
    cleanup();
    dom.window.close();
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    for (const sessionName of createdSessions) {
      runTmux(['kill-session', '-t', sessionName], `cleanup ${sessionName}`, true);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
