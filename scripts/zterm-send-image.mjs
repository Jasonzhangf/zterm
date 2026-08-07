#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function readOption(args, name, required = true) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : '';
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} is required`);
  return value || '';
}

const args = process.argv.slice(2);
const filePath = resolve(readOption(args, '--file'));
const targetDeviceIds = args.flatMap((_, index) => args[index] === '--target-device' ? [args[index + 1] || ''] : []).filter(Boolean);
if (targetDeviceIds.length === 0) throw new Error('--target-device is required');
const data = await readFile(filePath);
const mimeType = readOption(args, '--mime-type', false) || (filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
const endpoint = process.env.ZTERM_ATTACHMENT_API || 'http://127.0.0.1:3333/api/v1/attachments/images';
const token = process.env.ZTERM_DAEMON_TOKEN || '';
const senderAgentId = process.env.ZTERM_AGENT_ID || 'agent';
const senderName = process.env.ZTERM_AGENT_NAME || senderAgentId;
const clientRequestId = readOption(args, '--request-id', false) || `${senderAgentId}:${filePath}:${data.byteLength}:${data.subarray(0, 16).toString('hex')}`;
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({
    fileName: basename(filePath), mimeType, dataBase64: data.toString('base64'), senderAgentId, senderName, clientRequestId, targetDeviceIds,
    sourceSession: readOption(args, '--session', false) || undefined,
    message: readOption(args, '--message', false) || undefined,
  }),
});
const body = await response.text();
if (!response.ok) throw new Error(`zterm attachment API ${response.status}: ${body}`);
process.stdout.write(`${body}\n`);
