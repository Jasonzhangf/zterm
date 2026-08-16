/**
 * traversal-relay server 纯 helper 子模块（relay.account_directory）。
 * 从 server.ts 拆出：字符串/HTTP/JSON/socket envelope/key 等无状态纯函数。
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { WebSocket } from 'ws';

interface SignalMessage {
  type: 'rtc-init' | 'rtc-offer' | 'rtc-answer' | 'rtc-candidate' | 'rtc-close' | 'rtc-error';
  payload?: Record<string, unknown>;
}

interface RelayHostEnvelope {
  type: 'relay-ready' | 'relay-signal' | 'relay-peer-close' | 'relay-error' | 'directory-update';
  peerId?: string;
  message?: SignalMessage;
  reason?: string;
  hostId?: string;
  directory?: {
    endpoints?: RelayEndpointCandidate[];
    sessions?: RelayTmuxSessionSnapshot[];
    publishedAt?: string;
  };
}

interface DevicePresenceOutputEnvelope {
  type: 'devices-snapshot' | 'device-updated' | 'directory-snapshot' | 'control-pong' | 'relay-error' | 'client-debug-request';
  payload?: Record<string, unknown>;
  reason?: string;
}

import type { RelayEndpointCandidate, RelayTmuxSessionSnapshot } from '@zterm/shared/relay-directory';

export function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function writeCorsHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
}

export function serveJson(
  response: ServerResponse,
  payload: unknown,
  statusCode = 200,
  options: { omitBody?: boolean } = {},
) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(options.omitBody ? undefined : JSON.stringify(payload));
}

export function serveHtml(response: ServerResponse, html: string, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw.trim() ? JSON.parse(raw) as T : {} as T;
}

export function extractAccessToken(request: IncomingMessage, url: URL) {
  const authHeader = asString(request.headers.authorization);
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return asString(url.searchParams.get('token') || url.searchParams.get('accessToken'));
}

export function sendHostEnvelope(socket: WebSocket, envelope: RelayHostEnvelope) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(envelope));
}

export function sendDeviceEnvelope(socket: WebSocket, envelope: DevicePresenceOutputEnvelope) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(envelope));
}

export function hostKey(userId: string, hostId: string) {
  return `${userId}:${hostId}`;
}

export function deviceKey(userId: string, deviceId: string) {
  return `${userId}:${deviceId}`;
}

export function clientPeerLeaseKey(userId: string, hostId: string, deviceId: string) {
  const normalizedDeviceId = asString(deviceId);
  if (!normalizedDeviceId) {
    return null;
  }
  return `${userId}:${hostId}:${normalizedDeviceId}`;
}
