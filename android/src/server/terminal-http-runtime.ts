import { createReadStream, existsSync, readFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { basename, join, resolve } from 'path';
import type { RuntimeDebugSourceMeta, RuntimeDebugStore } from './runtime-debug-store';
import type { TerminalTransportSubscriber, SessionMirror, TerminalSessionTransport } from './terminal-runtime-types';
import type { RuntimeDebugLogEntry, TerminalTransportServerFrame } from '@zterm/shared/protocol';
import {
  parseRuntimeDebugPerformanceTraceRecords,
  summarizeTerminalPerformanceTrace,
  type createTerminalPerformanceTraceStore,
} from '@zterm/shared/terminal/performance-trace';
import { DebugPermissionService } from '@zterm/shared/terminal/debug-contract';
import { validateAttachmentId, type AttachmentDeliveryRuntime, type AttachmentAsset } from './attachment-delivery-runtime';

const ATTACHMENT_HTTP_BODY_MAX_BYTES = 44 * 1024 * 1024;
const DEBUG_HTTP_BODY_MAX_BYTES = 512 * 1024;
const DEBUG_CONTROL_DEFAULT_LEASE_MS = 10 * 60 * 1000;

export interface TerminalHttpRuntimeDeps {
  host: string;
  port: number;
  daemonHostId?: string;
  requiredAuthToken: string;
  updatesDir: string;
  appUpdateVersionCode: number;
  appUpdateVersionName: string;
  appUpdateManifestUrl: string;
  sessions: Map<string, TerminalTransportSubscriber>;
  mirrors: Map<string, SessionMirror>;
  clientRuntimeDebugStore: RuntimeDebugStore;
  daemonRuntimeDebugStore: RuntimeDebugStore;
  performanceTraceStore: ReturnType<typeof createTerminalPerformanceTraceStore>;
  resolveDebugRouteLimit: (input: string | null | undefined) => number;
  broadcastRuntimeDebugControl: (enabled: boolean, reason: string, sessionId?: string) => void;
  setDaemonRuntimeDebugEnabled: (enabled: boolean) => void;
  setDaemonRuntimeDebugLease: (enabled: boolean, leaseMs: number) => void;
  debugPermissionService?: DebugPermissionService;
  handleClientDebugLog: (source: RuntimeDebugSourceMeta, payload: { entries: Array<{ seq: number; ts: string; scope: string; payload?: string }> }) => void;
  handleClientDebugSnapshot: (source: RuntimeDebugSourceMeta, payload: { snapshot?: unknown }) => void;
  logTimePrefix: (date?: Date) => string;
  attachmentDeliveryRuntime?: AttachmentDeliveryRuntime;
  connections: Map<string, { deviceId?: string; transport: TerminalSessionTransport }>;
  sendTransportMessage: (transport: TerminalSessionTransport | null | undefined, message: TerminalTransportServerFrame) => void;
}

export interface TerminalHttpRuntime {
  resolveRequestOrigin: (request: IncomingMessage) => string;
  buildConnectedPayload: (sessionId: string, requestOrigin?: string) => {
    sessionId: string;
    daemonHostId?: string;
    appUpdate?: {
      versionCode: number;
      versionName: string;
      manifestUrl: string;
    };
  };
  handleHttpRequest: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

export function createTerminalHttpRuntime(deps: TerminalHttpRuntimeDeps): TerminalHttpRuntime {
  const debugPermissionService = deps.debugPermissionService ?? new DebugPermissionService();

  function isLoopbackHost(host: string) {
    const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
  }

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
    const manifestUrl = deps.appUpdateManifestUrl
      || `${requestOrigin || `http://${deps.host}:${deps.port}`}/updates/latest.json`;
    return {
      sessionId,
      daemonHostId: deps.daemonHostId?.trim() || undefined,
      capabilities: {
        reliableInput: { version: 1 },
      },
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
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    const subscriberEntries = Array.from(deps.sessions.values());
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
        total: subscriberEntries.length,
        attached: subscriberEntries.filter((subscriber) => Boolean(subscriber.transport)).length,
        ready: subscriberEntries.filter((subscriber) => Boolean(subscriber.connectedSent || subscriber.transport?.connectedSent)).length,
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
    if (!deps.requiredAuthToken && !isLoopbackHost(deps.host)) {
      serveJson(response, { message: 'debug access requires daemon token' }, 401);
      return false;
    }
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

  function ensureAttachmentAuthorized(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!deps.requiredAuthToken) return true;
    const providedToken = extractHttpDebugToken(request, url);
    if (providedToken === deps.requiredAuthToken) return true;
    serveJson(response, { message: 'unauthorized attachment access' }, 401);
    return false;
  }

  function readRequestBody(request: IncomingMessage) {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      request.on('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += data.byteLength;
        if (receivedBytes > ATTACHMENT_HTTP_BODY_MAX_BYTES) {
          reject(new Error('attachment request body exceeds limit'));
          return;
        }
        chunks.push(data);
      });
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }

  function readDebugJsonBody(request: IncomingMessage) {
    return new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      request.on('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += data.byteLength;
        if (receivedBytes > DEBUG_HTTP_BODY_MAX_BYTES) {
          reject(new Error('debug observability request body exceeds limit'));
          return;
        }
        chunks.push(data);
      });
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) {
          reject(new Error('debug observability request body is required'));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error instanceof Error ? error : new Error('invalid debug observability JSON'));
        }
      });
      request.on('error', reject);
    });
  }

  function decodeAttachmentBase64(input: string) {
    const normalized = input.trim();
    if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      throw new Error('invalid attachment base64');
    }
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.toString('base64') !== normalized) {
      throw new Error('invalid attachment base64');
    }
    return decoded;
  }

  function buildDebugRuntimeSnapshot(request: IncomingMessage) {
    const subscriberEntries = Array.from(deps.sessions.values());
    const mirrorEntries = Array.from(deps.mirrors.values());
    const traceLimit = 1000;
    const daemonTraceRecords = deps.performanceTraceStore.snapshot();
    const clientTraceRecords = parseRuntimeDebugPerformanceTraceRecords(
      deps.clientRuntimeDebugStore.listEntries({
        limit: traceLimit,
        scopeIncludes: 'terminal.performance.trace',
      }),
    );
    const daemonDebugTraceRecords = parseRuntimeDebugPerformanceTraceRecords(
      deps.daemonRuntimeDebugStore.listEntries({
        limit: traceLimit,
        scopeIncludes: 'terminal.performance.trace',
      }),
    );
    const performanceTraceRecords = [
      ...daemonTraceRecords,
      ...clientTraceRecords,
      ...daemonDebugTraceRecords,
    ];
    return {
      ok: true,
      generatedAt: deps.logTimePrefix(),
      authEnabled: Boolean(deps.requiredAuthToken),
      health: buildRuntimeHealthSnapshot(request),
      clientDebug: deps.clientRuntimeDebugStore.getSummary(),
      daemonDebug: deps.daemonRuntimeDebugStore.getSummary(),
      performanceTrace: {
        recordCount: performanceTraceRecords.length,
        summary: summarizeTerminalPerformanceTrace(performanceTraceRecords),
      },
      clientDebugSnapshots: deps.clientRuntimeDebugStore.listSnapshots(),
      transportSubscribers: subscriberEntries.map((subscriber) => ({
        id: subscriber.id,
        sessionName: subscriber.sessionName,
        mirrorKey: subscriber.mirrorKey,
        transportId: subscriber.transportId,
        connectedSent: Boolean(subscriber.connectedSent || subscriber.transport?.connectedSent),
        muxChannelId: subscriber.muxChannelId || null,
        requestOrigin: subscriber.transport?.requestOrigin || null,
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

  function normalizeDebugObservabilityPayload(body: unknown, request: IncomingMessage): {
    source: RuntimeDebugSourceMeta;
    entries: RuntimeDebugLogEntry[] | null;
    snapshot: unknown;
    hasSnapshot: boolean;
  } | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    const candidate = body as Record<string, unknown>;
    const payload = typeof candidate.kind === 'string' && candidate.payload
      ? candidate.payload as Record<string, unknown>
      : candidate;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const entries = Array.isArray(payload.entries)
      ? payload.entries.filter((entry): entry is RuntimeDebugLogEntry => (
          Boolean(entry)
          && typeof entry === 'object'
          && typeof (entry as { scope?: unknown }).scope === 'string'
        ))
      : null;
    return {
      source: {
        sessionId: 'client-runtime',
        tmuxSessionName: 'client',
        requestOrigin: resolveRequestOrigin(request),
      },
      entries,
      snapshot: payload.snapshot,
      hasSnapshot: Object.prototype.hasOwnProperty.call(payload, 'snapshot'),
    };
  }

  async function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
    writeCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    const origin = resolveRequestOrigin(request);
    const url = new URL(request.url || '/', origin);

    if (deps.attachmentDeliveryRuntime && (url.pathname === '/api/v1/attachments' || url.pathname === '/api/v1/attachments/images' || url.pathname.startsWith('/api/v1/attachments/'))) {
      if (!ensureAttachmentAuthorized(request, response, url)) return;
      try {
        if (url.pathname === '/api/v1/attachments/images' && request.method === 'POST') {
          const payload = JSON.parse((await readRequestBody(request)).toString('utf8')) as {
            fileName?: string; mimeType?: string; dataBase64?: string; senderAgentId?: string; senderName?: string;
            sourceSession?: string; clientRequestId?: string; targetDeviceIds?: string[]; message?: string;
          };
          const required = [payload.fileName, payload.mimeType, payload.dataBase64, payload.senderAgentId, payload.senderName, payload.clientRequestId];
          if (required.some((value) => typeof value !== 'string' || !value.trim()) || !Array.isArray(payload.targetDeviceIds)) throw new Error('invalid attachment create request');
          const manifest = await deps.attachmentDeliveryRuntime.enqueueImage({
            fileName: payload.fileName!, mimeType: payload.mimeType!, data: decodeAttachmentBase64(payload.dataBase64!),
            senderAgentId: payload.senderAgentId!, senderName: payload.senderName!,
            sourceSession: typeof payload.sourceSession === 'string' ? payload.sourceSession : undefined,
            clientRequestId: payload.clientRequestId!,
            targetDeviceIds: payload.targetDeviceIds, message: payload.message,
          });
          serveJson(response, { ok: true, attachmentId: manifest.attachmentId, status: manifest.status, manifest });
          // Push notification to target devices
          void (async () => {
            try {
              for (const targetDeviceId of (manifest.deliveries || []).map(d => d.targetDeviceId)) {
                for (const conn of deps.connections.values()) {
                  if (conn.deviceId === targetDeviceId && conn.transport) {
                    deps.sendTransportMessage(conn.transport, {
                      type: 'pending-attachments',
                      payload: {
                        schemaVersion: 1,
                        pending: [{
                          attachmentId: manifest.attachmentId,
                          kind: manifest.kind,
                          senderName: manifest.senderName,
                          fileName: manifest.fileName,
                          mimeType: manifest.mimeType,
                          previewSize: manifest.preview.size,
                          originalSize: manifest.original.size,
                          message: manifest.message,
                          createdAt: manifest.createdAt,
                          expiresAt: manifest.expiresAt,
                        }],
                      },
                    });
                  }
                }
              }
            } catch (err) {
              console.error(`[${deps.logTimePrefix()}] push attachment notification failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
          return;
        }
        const receiptMatch = url.pathname.match(/^\/api\/v1\/attachments\/([^/]+)\/receipt$/);
        if (receiptMatch && request.method === 'POST') {
          const payload = JSON.parse((await readRequestBody(request)).toString('utf8')) as { deviceId?: string; asset?: AttachmentAsset; sha256?: string };
          if (!payload.deviceId || (payload.asset !== 'preview' && payload.asset !== 'original') || !payload.sha256) throw new Error('invalid attachment receipt');
          serveJson(response, { ok: true, manifest: await deps.attachmentDeliveryRuntime.acknowledge(decodeURIComponent(receiptMatch[1]), payload.deviceId, payload.asset, payload.sha256) });
          return;
        }
        if (url.pathname === '/api/v1/attachments' && request.method === 'GET') {
          const deviceId = url.searchParams.get('deviceId')?.trim() || '';
          if (!deviceId) throw new Error('deviceId is required');
          const asset = url.searchParams.get('asset') as AttachmentAsset;
          if (asset && asset !== 'preview' && asset !== 'original') throw new Error('invalid attachment asset');
          serveJson(response, {
            ok: true,
            items: await deps.attachmentDeliveryRuntime.listForDevice(deviceId, asset || 'preview'),
          });
          return;
        }
        const match = url.pathname.match(/^\/api\/v1\/attachments\/([^/]+)(?:\/(preview|original))?$/);
        if (!match) { serveJson(response, { message: 'not found' }, 404); return; }
        const attachmentId = validateAttachmentId(decodeURIComponent(match[1]));
        if (match[2] && request.method === 'GET') {
          const deviceId = url.searchParams.get('deviceId')?.trim() || '';
          if (!deviceId) throw new Error('deviceId is required');
          const asset = match[2] as AttachmentAsset;
          const result = await deps.attachmentDeliveryRuntime.readAsset(attachmentId, asset, deviceId);
          response.statusCode = 200;
          response.setHeader('Content-Type', asset === 'preview' ? result.manifest.preview.mimeType : result.manifest.mimeType);
          response.setHeader('Content-Length', result.data.byteLength);
          response.end(result.data);
          return;
        }
        if (request.method === 'GET') {
          const deviceId = url.searchParams.get('deviceId')?.trim() || '';
          if (!deviceId) throw new Error('deviceId is required');
          const asset = url.searchParams.get('asset') as AttachmentAsset;
          if (asset && asset !== 'preview' && asset !== 'original') throw new Error('invalid attachment asset');
          serveJson(response, { ok: true, items: await deps.attachmentDeliveryRuntime.listForDevice(deviceId, asset || 'preview') });
          return;
        }
        serveJson(response, { message: 'method not allowed' }, 405);
      } catch (error) {
        serveJson(response, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === '/health') {
      serveJson(response, buildRuntimeHealthSnapshot(request));
      return;
    }

    if (url.pathname === '/debug/runtime') {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      if (request.method !== 'GET') {
        serveJson(response, { message: 'method not allowed' }, 405);
        return;
      }
      serveJson(response, buildDebugRuntimeSnapshot(request));
      return;
    }

    if (url.pathname === '/debug/runtime/logs') {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      if (request.method === 'POST') {
        try {
          const body = await readDebugJsonBody(request);
          const ingest = normalizeDebugObservabilityPayload(body, request);
          if (!ingest || !ingest.entries) {
            serveJson(response, { message: 'debug observability log entries are required' }, 400);
            return;
          }
          deps.handleClientDebugLog(ingest.source, { entries: ingest.entries });
          serveJson(response, {
            ok: true,
            sessionId: ingest.source.sessionId,
            tmuxSessionName: ingest.source.tmuxSessionName,
            returned: ingest.entries.length,
          });
        } catch (error) {
          serveJson(response, { message: error instanceof Error ? error.message : String(error) }, 400);
        }
        return;
      }
      if (request.method !== 'GET') {
        serveJson(response, { message: 'method not allowed' }, 405);
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
      const daemonEntries = deps.daemonRuntimeDebugStore.listEntries({
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
        daemonReturned: daemonEntries.length,
        filters: {
          sessionId: sessionId || null,
          tmuxSessionName: tmuxSessionName || null,
          scope: scopeIncludes || null,
        },
        entries,
        daemonEntries,
      });
      return;
    }

    if (url.pathname === '/debug/runtime/snapshot') {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      if (request.method !== 'POST') {
        serveJson(response, { message: 'method not allowed' }, 405);
        return;
      }
      try {
        const body = await readDebugJsonBody(request);
        const ingest = normalizeDebugObservabilityPayload(body, request);
        if (!ingest || !ingest.hasSnapshot) {
          serveJson(response, { message: 'debug observability snapshot is required' }, 400);
          return;
        }
        deps.handleClientDebugSnapshot(ingest.source, { snapshot: ingest.snapshot });
        serveJson(response, {
          ok: true,
          sessionId: ingest.source.sessionId,
          tmuxSessionName: ingest.source.tmuxSessionName,
        });
      } catch (error) {
        serveJson(response, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === '/debug/runtime/control') {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      if (request.method !== 'POST') {
        serveJson(response, { message: 'debug control mutation requires POST' }, 405);
        return;
      }
      if (!debugPermissionService.can('debug:control')) {
        serveJson(response, { message: 'debug control lease not granted or expired' }, 403);
        return;
      }
      try {
        const body = await readDebugJsonBody(request);
        const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        const enabled = raw.enabled === true || raw.enabled === '1' || raw.enabled === 'true' || raw.enabled === 'on';
        const parsedTtlMs = Number(raw.ttlMs);
        const ttlMs = Number.isFinite(parsedTtlMs) && parsedTtlMs > 0 ? parsedTtlMs : DEBUG_CONTROL_DEFAULT_LEASE_MS;
        const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
        const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : 'remote-http-control';
        deps.setDaemonRuntimeDebugLease(enabled, ttlMs);
        deps.broadcastRuntimeDebugControl(enabled, reason, sessionId || undefined);
        serveJson(response, {
          ok: true,
          enabled,
          daemonDebugEnabled: enabled,
          leaseMs: enabled ? ttlMs : null,
          expiresAt: enabled ? new Date(Date.now() + ttlMs).toISOString() : null,
          reason,
          sessionId: sessionId || null,
          targetedSessions: sessionId
            ? Array.from(deps.sessions.values()).filter((session) => session.id === sessionId).map((session) => session.id)
            : Array.from(deps.sessions.values()).map((session) => session.id),
        });
      } catch (error) {
        serveJson(response, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === '/updates/latest.json') {
      const manifestPath = join(deps.updatesDir, 'latest.json');
      if (!existsSync(manifestPath)) {
        serveJson(response, { message: 'update manifest not found' }, 404);
        return;
      }

      try {
        // Keep apkUrl exactly as emitted by the build pipeline. Rewriting it
        // against the current request origin can pin the download target to
        // localhost, which breaks mobile upgrades when the manifest is checked
        // through a local daemon endpoint.
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
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
