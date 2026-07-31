import { existsSync } from 'fs';
import type { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import type { TerminalTransportServerFrame } from '@zterm/shared/protocol';
import type { TerminalSessionTransport } from './terminal-runtime-types';
import type { TerminalSession, SessionMirror } from './terminal-runtime';
import type { DaemonTransportConnection } from './terminal-transport-runtime';
import { TERMINAL_TRANSPORT_STALE_INBOUND_MS } from './terminal-transport-runtime';
import { publishSessionActivitiesRuntime } from './terminal-session-activity-runtime';

export interface DestroyMirrorOptions {
  closeTransportSubscribers?: boolean;
  notifyClientClose?: boolean;
  releaseCode?: string;
}

export interface TerminalDaemonRuntimeDeps {
  host: string;
  port: number;
  requiredAuthToken: string;
  updatesDir: string;
  tmuxBinary: string;
  defaultSessionName: string;
  logDir: string;
  configDisplayPath: string;
  authLabel: string;
  relayLabel: string;
  terminalCacheLines: number;
  wsHeartbeatIntervalMs: number;
  memoryGuardIntervalMs: number;
  memoryGuardMaxRssBytes: number;
  memoryGuardMaxHeapUsedBytes: number;
  startupPortConflictExitCode: number;
  sessions: Map<string, TerminalSession>;
  connections: Map<string, DaemonTransportConnection>;
  mirrors: Map<string, SessionMirror>;
  server: Server;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
  wss: WebSocketServer;
  logTimePrefix: () => string;
  shutdownTerminalSessions: (sessions: Map<string, TerminalSession>, reason: string) => void;
  detachSubscriberTransportOnly: (subscriber: TerminalSession, reason: string, transportId?: string) => void;
  destroyMirror: (mirror: SessionMirror, reason: string, options?: DestroyMirrorOptions) => void;
  disposeScheduleRuntime: () => void;
  startRelayHostClient: () => void;
  disposeRelayHostClient: () => void;
  disposeRtcBridgeServer: () => void;
}

export interface TerminalDaemonRuntime {
  extractAuthToken: (rawUrl?: string) => string;
  startHeartbeatLoop: () => void;
  startMemoryGuardLoop: () => void;
  shutdownDaemon: (reason: string, exitCode?: number) => void;
  handleDaemonServerClosed: () => void;
  handleDaemonServerError: (error: unknown) => void;
  handleDaemonServerListening: () => void;
}

export function resolveTmuxBinary() {
  const override = process.env.ZTERM_TMUX_BINARY?.trim();
  if (override) {
    return override;
  }

  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    'tmux',
  ];

  const existingCandidate = candidates.find((candidate) => candidate === 'tmux' || existsSync(candidate));
  return existingCandidate || 'tmux';
}

export function createTerminalDaemonRuntime(
  deps: TerminalDaemonRuntimeDeps,
): TerminalDaemonRuntime {
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let memoryGuardTimer: ReturnType<typeof setInterval> | null = null;
  let shutdownInFlight = false;

  function clearHeartbeatLoop() {
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearMemoryGuardLoop() {
    if (!memoryGuardTimer) {
      return;
    }
    clearInterval(memoryGuardTimer);
    memoryGuardTimer = null;
  }

  function extractAuthToken(rawUrl?: string) {
    try {
      const url = new URL(rawUrl || '/', 'ws://localhost');
      return url.searchParams.get('token')?.trim() || '';
    } catch (error) {
      console.warn(
        `[${deps.logTimePrefix()}] failed to parse websocket auth token from "${rawUrl || ''}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return '';
    }
  }

  function startHeartbeatLoop() {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const connection of deps.connections.values()) {
        const boundSubscriberIds = new Set<string>();
        if (connection.boundSubscriberId) {
          boundSubscriberIds.add(connection.boundSubscriberId);
        }
        for (const subscriberId of connection.muxChannels?.values() || []) {
          boundSubscriberIds.add(subscriberId);
        }

        if (connection.transport.readyState === WebSocket.OPEN && boundSubscriberIds.size > 0) {
          const lastInboundAt = Math.max(0, Math.floor(connection.lastInboundAt || 0));
          const staleForMs = lastInboundAt > 0 ? now - lastInboundAt : Number.POSITIVE_INFINITY;
          if (staleForMs > TERMINAL_TRANSPORT_STALE_INBOUND_MS) {
            const reason = 'transport heartbeat stale';
            console.warn(
              `[${deps.logTimePrefix()}] transport ${connection.id} stale inbound heartbeat kind=${connection.transport.kind} staleForMs=${Math.floor(staleForMs)}`,
            );
            for (const subscriberId of boundSubscriberIds) {
              const subscriber = deps.sessions.get(subscriberId) || null;
              if (!subscriber) {
                continue;
              }
              deps.detachSubscriberTransportOnly(subscriber, reason, connection.transportId);
            }
            connection.muxChannels?.clear();
            try {
              connection.closeTransport(reason);
            } catch (error) {
              console.warn(
                `[${deps.logTimePrefix()}] failed to close stale transport ${connection.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            deps.connections.delete(connection.id);
            continue;
          }
        }

        if (connection.transport.readyState !== WebSocket.OPEN) {
          continue;
        }

        if (boundSubscriberIds.size > 0) {
          publishSessionActivitiesRuntime({
            connection,
            mirrors: deps.mirrors,
            now,
            sendTransportMessage: deps.sendTransportMessage,
          });
        }

        if (connection.transport.kind === 'ws') {
          if (!connection.wsAlive) {
            console.warn(`[${deps.logTimePrefix()}] transport ${connection.id} heartbeat missed pong`);
          }
          connection.wsAlive = false;
          try {
            connection.transport.ping?.();
          } catch (error) {
            console.warn(
              `[${deps.logTimePrefix()}] transport ${connection.id} heartbeat ping failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            connection.transport.close('heartbeat ping failed');
          }
        }
      }
    }, deps.wsHeartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function startMemoryGuardLoop() {
    if (memoryGuardTimer) {
      return;
    }
    memoryGuardTimer = setInterval(() => {
      const usage = process.memoryUsage();
      if (usage.rss < deps.memoryGuardMaxRssBytes && usage.heapUsed < deps.memoryGuardMaxHeapUsedBytes) {
        return;
      }

      console.error(
        `[${deps.logTimePrefix()}] daemon memory guard tripped: rss=${usage.rss} heapUsed=${usage.heapUsed} sessions=${deps.sessions.size} mirrors=${deps.mirrors.size}`,
      );
      shutdownDaemon('memory guard', 70);
    }, deps.memoryGuardIntervalMs);
    memoryGuardTimer.unref?.();
  }

  function shutdownDaemon(reason: string, exitCode = 0) {
    if (shutdownInFlight) {
      return;
    }
    shutdownInFlight = true;

    console.log(`[${deps.logTimePrefix()}] daemon shutdown start: ${reason}`);
    clearHeartbeatLoop();
    clearMemoryGuardLoop();
    deps.disposeScheduleRuntime();
    deps.disposeRelayHostClient();

    for (const connection of deps.connections.values()) {
      try {
        connection.closeTransport(reason);
      } catch (error) {
        console.warn(
          `[${deps.logTimePrefix()}] failed to close transport ${connection.id} during daemon shutdown: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    deps.connections.clear();
    deps.shutdownTerminalSessions(deps.sessions, reason);

    for (const mirror of [...deps.mirrors.values()]) {
      deps.destroyMirror(mirror, reason, {
        closeTransportSubscribers: true,
        notifyClientClose: true,
      });
    }

    const finalize = () => {
      process.exit(exitCode);
    };

    try {
      deps.wss.close();
    } catch (error) {
      console.warn(`[${deps.logTimePrefix()}] websocket server close failed:`, error);
    }

    deps.server.close((error) => {
      if (error) {
        console.warn(`[${deps.logTimePrefix()}] http server close failed: ${error.message}`);
      }
      finalize();
    });

    setTimeout(finalize, 1500).unref?.();
  }

  function handleDaemonServerClosed() {
    clearHeartbeatLoop();
    clearMemoryGuardLoop();
    deps.disposeScheduleRuntime();
    deps.disposeRelayHostClient();
    deps.disposeRtcBridgeServer();
  }

  function handleDaemonServerError(error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `[${deps.logTimePrefix()}] daemon listen conflict on ${deps.host}:${deps.port}; another process is already bound to this port`,
      );
      shutdownDaemon('listen conflict', deps.startupPortConflictExitCode);
      return;
    }

    console.error(
      `[${deps.logTimePrefix()}] daemon server error: ${error instanceof Error ? error.message : String(error)}`,
    );
    shutdownDaemon('server error', 1);
  }

  function handleDaemonServerListening() {
    deps.startRelayHostClient();
    console.log(`[${deps.logTimePrefix()}] zterm tmux bridge listening on ws://${deps.host}:${deps.port}`);
    console.log(`  - health: http://${deps.host}:${deps.port}/health`);
    console.log(`  - rtc signal: ws://${deps.host}:${deps.port}/signal${deps.requiredAuthToken ? '?token=<auth>' : ''}`);
    console.log(`  - runtime debug snapshot: http://${deps.host}:${deps.port}/debug/runtime${deps.requiredAuthToken ? '?token=<auth>' : ''}`);
    console.log(`  - runtime debug logs: http://${deps.host}:${deps.port}/debug/runtime/logs${deps.requiredAuthToken ? '?token=<auth>&limit=200' : '?limit=200'}`);
    console.log(`  - runtime debug control: http://${deps.host}:${deps.port}/debug/runtime/control${deps.requiredAuthToken ? '?token=<auth>&enabled=1' : '?enabled=1'}`);
    console.log(`  - updates manifest: http://${deps.host}:${deps.port}/updates/latest.json`);
    console.log(`  - updates dir: ${deps.updatesDir}`);
    console.log(`  - tmux binary: ${deps.tmuxBinary}`);
    console.log(`  - default session: ${deps.defaultSessionName}`);
    console.log(`  - active logs: ${deps.logDir}`);
    console.log(`  - auth: ${deps.authLabel}`);
    console.log(`  - config: ${deps.configDisplayPath}`);
    console.log(`  - terminal cache lines: ${deps.terminalCacheLines}`);
    console.log(`  - traversal relay: ${deps.relayLabel}`);
  }

  return {
    extractAuthToken,
    startHeartbeatLoop,
    startMemoryGuardLoop,
    shutdownDaemon,
    handleDaemonServerClosed,
    handleDaemonServerError,
    handleDaemonServerListening,
  };
}
