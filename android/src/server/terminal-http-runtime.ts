import { createReadStream, existsSync, readFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { basename, join, resolve } from 'path';
import type { RuntimeDebugStore } from './runtime-debug-store';
import type { TerminalSession, SessionMirror } from './terminal-runtime-types';

export interface TerminalHttpRuntimeDeps {
  host: string;
  port: number;
  requiredAuthToken: string;
  updatesDir: string;
  appUpdateVersionCode: number;
  appUpdateVersionName: string;
  appUpdateManifestUrl: string;
  sessions: Map<string, TerminalSession>;
  mirrors: Map<string, SessionMirror>;
  clientRuntimeDebugStore: RuntimeDebugStore;
  resolveDebugRouteLimit: (input: string | null | undefined) => number;
  broadcastRuntimeDebugControl: (enabled: boolean, reason: string, sessionId?: string) => void;
  logTimePrefix: (date?: Date) => string;
}

export interface TerminalHttpRuntime {
  resolveRequestOrigin: (request: IncomingMessage) => string;
  buildConnectedPayload: (sessionId: string, requestOrigin?: string) => {
    sessionId: string;
    appUpdate?: {
      versionCode: number;
      versionName: string;
      manifestUrl: string;
    };
  };
  handleHttpRequest: (request: IncomingMessage, response: ServerResponse) => void;
}

export function createTerminalHttpRuntime(deps: TerminalHttpRuntimeDeps): TerminalHttpRuntime {
  function readLatestUpdateManifest() {
    const manifestPath = join(deps.updatesDir, 'latest.json');
    if (!existsSync(manifestPath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        versionCode?: number;
        versionName?: string;
      };
    } catch (error) {
      console.warn(`[${deps.logTimePrefix()}] failed to parse update manifest: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function resolveRequestOrigin(request: IncomingMessage) {
    const host = request.headers.host || `${deps.host}:${deps.port}`;
    const protocol = 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
    return `${protocol}://${host}`;
  }

  function buildConnectedPayload(sessionId: string, requestOrigin?: string) {
    const latestManifest = readLatestUpdateManifest();
    const manifestUrl = `${requestOrigin || `http://${deps.host}:${deps.port}`}/updates/latest.json`;
    return {
      sessionId,
      appUpdate:
        latestManifest && Number.isFinite(latestManifest.versionCode) && latestManifest.versionCode! > 0 && latestManifest.versionName
          ? {
              versionCode: latestManifest.versionCode!,
              versionName: latestManifest.versionName,
              manifestUrl,
            }
          : Number.isFinite(deps.appUpdateVersionCode) && deps.appUpdateVersionCode > 0 && deps.appUpdateVersionName
            ? {
                versionCode: deps.appUpdateVersionCode,
                versionName: deps.appUpdateVersionName,
                manifestUrl: deps.appUpdateManifestUrl || manifestUrl,
              }
            : undefined,
    };
  }

  function writeCorsHeaders(response: ServerResponse) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ZTerm-Token');
  }

  function serveJson(response: ServerResponse, payload: unknown, statusCode = 200) {
    writeCorsHeaders(response);
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(`${JSON.stringify(payload, null, 2)}\n`);
  }

  function resolveUpdateFilePath(pathname: string) {
    const relativePath = pathname.replace(/^\/updates\//, '');
    const safeName = basename(relativePath);
    const absolutePath = resolve(deps.updatesDir, safeName);
    if (!absolutePath.startsWith(resolve(deps.updatesDir))) {
      return null;
    }
    return absolutePath;
  }

  function getMirrorAvailableEndIndex(mirror: SessionMirror) {
    return mirror.bufferStartIndex + mirror.bufferLines.length;
  }

  function buildRuntimeHealthSnapshot(request: IncomingMessage) {
    const requestHost = request.headers.host || `${deps.host}:${deps.port}`;
    const memoryUsage = process.memoryUsage();
    const sessionEntries = Array.from(deps.sessions.values());
    const mirrorEntries = Array.from(deps.mirrors.values());
    return {
      ok: true,
      wsUrl: `ws://${requestHost}`,
      updatesUrl: `${resolveRequestOrigin(request)}/updates/latest.json`,
      updatesDir: deps.updatesDir,
      uptimeSec: Math.floor(process.uptime()),
      pid: process.pid,
      memory: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers,
      },
      sessions: {
        total: sessionEntries.length,
        attached: sessionEntries.filter((session) => Boolean(session.transport)).length,
        ready: sessionEntries.filter((session) => Boolean(session.transport?.connectedSent)).length,
      },
      mirrors: {
        total: mirrorEntries.length,
        ready: mirrorEntries.filter((mirror) => mirror.lifecycle === 'ready').length,
        subscribers: mirrorEntries.reduce((sum, mirror) => sum + mirror.subscribers.size, 0),
      },
    };
  }

  function extractHttpDebugToken(request: IncomingMessage, url: URL) {
    const authorization = request.headers.authorization?.trim() || '';
    if (authorization.toLowerCase().startsWith('bearer ')) {
      return authorization.slice(7).trim();
    }
    const headerToken = request.headers['x-zterm-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.trim();
    }
    return url.searchParams.get('token')?.trim() || '';
  }

  function ensureDebugAuthorized(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!deps.requiredAuthToken) {
      return true;
    }
    const providedToken = extractHttpDebugToken(request, url);
    if (providedToken === deps.requiredAuthToken) {
      return true;
    }
    serveJson(response, { message: 'unauthorized debug access' }, 401);
    return false;
  }

  function buildDebugRuntimeSnapshot(request: IncomingMessage) {
    const sessionEntries = Array.from(deps.sessions.values());
    const mirrorEntries = Array.from(deps.mirrors.values());
    return {
      ok: true,
      generatedAt: deps.logTimePrefix(),
      authEnabled: Boolean(deps.requiredAuthToken),
      health: buildRuntimeHealthSnapshot(request),
      clientDebug: deps.clientRuntimeDebugStore.getSummary(),
      clientSessions: sessionEntries.map((session) => ({
        id: session.id,
        sessionName: session.sessionName,
        mirrorKey: session.mirrorKey,
        transportId: session.transportId,
        connectedSent: Boolean(session.transport?.connectedSent),
        requestOrigin: session.transport?.requestOrigin || null,
      })),
      mirrors: mirrorEntries.map((mirror) => ({
        key: mirror.key,
        sessionName: mirror.sessionName,
        lifecycle: mirror.lifecycle,
        revision: mirror.revision,
        latestEndIndex: getMirrorAvailableEndIndex(mirror),
        cols: mirror.cols,
        rows: mirror.rows,
        bufferStartIndex: mirror.bufferStartIndex,
        bufferEndIndex: getMirrorAvailableEndIndex(mirror),
        bufferedLines: mirror.bufferLines.length,
        cursorKeysApp: mirror.cursorKeysApp,
        subscribers: Array.from(mirror.subscribers),
        lastFlushStartedAt: mirror.lastFlushStartedAt,
        lastFlushCompletedAt: mirror.lastFlushCompletedAt,
        flushInFlight: mirror.flushInFlight,
      })),
    };
  }

  function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
    writeCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    const origin = resolveRequestOrigin(request);
    const url = new URL(request.url || '/', origin);

    if (url.pathname === '/health') {
      serveJson(response, buildRuntimeHealthSnapshot(request));
      return;
    }

    if (url.pathname === '/debug/runtime') {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      serveJson(response, buildDebugRuntimeSnapshot(request));
      return;
    }

    if (url.pathname === '/debug/runtime/logs') {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      const limit = deps.resolveDebugRouteLimit(url.searchParams.get('limit'));
      const sessionId = url.searchParams.get('sessionId')?.trim() || '';
      const tmuxSessionName = url.searchParams.get('tmuxSessionName')?.trim() || '';
      const scopeIncludes = url.searchParams.get('scope')?.trim() || '';
      const entries = deps.clientRuntimeDebugStore.listEntries({
        limit,
        sessionId: sessionId || undefined,
        tmuxSessionName: tmuxSessionName || undefined,
        scopeIncludes: scopeIncludes || undefined,
      });
      serveJson(response, {
        ok: true,
        generatedAt: deps.logTimePrefix(),
        limit,
        returned: entries.length,
        filters: {
          sessionId: sessionId || null,
          tmuxSessionName: tmuxSessionName || null,
          scope: scopeIncludes || null,
        },
        entries,
      });
      return;
    }

    if (url.pathname === '/debug/runtime/control') {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      const enabledRaw = (url.searchParams.get('enabled') || '').trim().toLowerCase();
      const enabled = enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'on';
      const sessionId = url.searchParams.get('sessionId')?.trim() || '';
      const reason = url.searchParams.get('reason')?.trim() || 'remote-http-control';
      deps.broadcastRuntimeDebugControl(enabled, reason, sessionId || undefined);
      serveJson(response, {
        ok: true,
        enabled,
        reason,
        sessionId: sessionId || null,
        targetedSessions: sessionId
          ? Array.from(deps.sessions.values()).filter((session) => session.id === sessionId).map((session) => session.id)
          : Array.from(deps.sessions.values()).map((session) => session.id),
      });
      return;
    }

    if (url.pathname === '/updates/latest.json') {
      const manifestPath = join(deps.updatesDir, 'latest.json');
      if (!existsSync(manifestPath)) {
        serveJson(response, { message: 'update manifest not found' }, 404);
        return;
      }

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
        const apkUrl = typeof manifest.apkUrl === 'string' ? manifest.apkUrl : '';
        if (apkUrl && !/^https?:\/\//.test(apkUrl)) {
          manifest.apkUrl = `${origin}/updates/${basename(apkUrl)}`;
        }
        serveJson(response, manifest);
      } catch (error) {
        serveJson(response, { message: `invalid update manifest: ${error instanceof Error ? error.message : String(error)}` }, 500);
      }
      return;
    }

    if (url.pathname.startsWith('/updates/')) {
      const filePath = resolveUpdateFilePath(url.pathname);
      if (!filePath || !existsSync(filePath)) {
        serveJson(response, { message: 'update file not found' }, 404);
        return;
      }

      response.statusCode = 200;
      response.setHeader('Content-Type', filePath.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream');
      createReadStream(filePath).pipe(response);
      return;
    }

    serveJson(response, { message: 'not found' }, 404);
  }

  return {
    resolveRequestOrigin,
    buildConnectedPayload,
    handleHttpRequest,
  };
}
