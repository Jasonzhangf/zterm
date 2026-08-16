import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ATTACHMENT_TTL_MS = 48 * 60 * 60 * 1000;
export const ATTACHMENT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
export const ATTACHMENT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export type AttachmentAsset = 'preview' | 'original';
export type AttachmentDeliveryStatus = 'pending' | 'pulling' | 'acknowledged' | 'failed' | 'expired';

export interface AttachmentDeliveryRecord {
  targetDeviceId: string;
  previewStatus: AttachmentDeliveryStatus;
  originalStatus: AttachmentDeliveryStatus;
  attemptCount: number;
  lastError?: string;
  acknowledgedAt?: string;
}

export interface AttachmentManifest {
  schemaVersion: 1;
  attachmentId: string;
  kind: 'image';
  senderAgentId: string;
  senderName: string;
  /** Optional tmux session name the sender was working in. */
  sourceSession?: string;
  fileName: string;
  mimeType: string;
  original: { size: number; sha256: string };
  preview: { fileName: string; mimeType: 'image/png'; size: number; sha256: string };
  message?: string;
  clientRequestId: string;
  createdAt: string;
  expiresAt: string;
  status: 'available' | 'expired';
  deliveries: AttachmentDeliveryRecord[];
}

export interface AttachmentDeliveryRuntime {
  enqueueImage: (input: {
    fileName: string;
    mimeType: string;
    data: Buffer;
    senderAgentId: string;
    senderName: string;
    sourceSession?: string;
    clientRequestId: string;
    targetDeviceIds: string[];
    message?: string;
  }) => Promise<AttachmentManifest>;
  listForDevice: (deviceId: string, asset?: AttachmentAsset, includeAcknowledged?: boolean) => Promise<AttachmentManifest[]>;
  readAsset: (attachmentId: string, asset: AttachmentAsset, deviceId: string) => Promise<{ manifest: AttachmentManifest; data: Buffer }>;
  acknowledge: (attachmentId: string, deviceId: string, asset: AttachmentAsset, sha256: string) => Promise<AttachmentManifest>;
  cleanup: () => Promise<{ expired: number; deleted: number }>;
}

function hash(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

function validateDeviceIds(deviceIds: string[]) {
  const normalized = Array.from(new Set(deviceIds.map((id) => id.trim()).filter(Boolean)));
  if (normalized.length === 0) throw new Error('at least one target device is required');
  if (normalized.some((id) => !/^[a-zA-Z0-9._:-]{1,160}$/.test(id))) {
    throw new Error('invalid target device id');
  }
  return normalized;
}

function validateFileName(fileName: string) {
  const normalized = fileName.trim();
  if (!normalized || normalized !== normalized.replace(/[^a-zA-Z0-9._ -]/g, '_') || normalized.includes('..')) {
    throw new Error('invalid attachment file name');
  }
  return normalized;
}

export function validateAttachmentId(attachmentId: string) {
  const normalized = attachmentId.trim();
  if (!/^att_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error('invalid attachment id');
  }
  return normalized;
}

async function makePreview(input: { source: string; output: string; platform: NodeJS.Platform }) {
  const command = input.platform === 'darwin' ? 'sips' : 'magick';
  const args = input.platform === 'darwin'
    ? ['-Z', '480', input.source, '--out', input.output, '--setProperty', 'format', 'png']
    : [input.source, '-thumbnail', '480x480>', input.output];
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`image preview generation failed: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });
}

export function createAttachmentDeliveryRuntime(options: {
  rootDir: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  generatePreview?: (source: string, output: string) => Promise<void>;
}): AttachmentDeliveryRuntime {
  const now = options.now || Date.now;
  const platform = options.platform || process.platform;
  const outboxDir = join(options.rootDir, 'outbox');
  const tombstoneDir = join(options.rootDir, 'tombstones');
  let operationQueue = Promise.resolve();
  const runExclusive = <T>(operation: () => Promise<T>) => {
    const result = operationQueue.then(operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const manifestPath = (id: string) => join(outboxDir, validateAttachmentId(id), 'manifest.json');
  const assetPath = (id: string, asset: AttachmentAsset) => join(outboxDir, validateAttachmentId(id), asset === 'original' ? 'original.bin' : 'preview.png');
  const readManifest = async (id: string) => JSON.parse(await readFile(manifestPath(id), 'utf8')) as AttachmentManifest;
  const writeManifest = async (manifest: AttachmentManifest) => {
    await writeFile(`${manifestPath(manifest.attachmentId)}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(`${manifestPath(manifest.attachmentId)}.tmp`, manifestPath(manifest.attachmentId));
  };

  async function listManifests() {
    await mkdir(outboxDir, { recursive: true });
    const ids = await readdir(outboxDir);
    const result: AttachmentManifest[] = [];
    for (const id of ids) {
      try {
        result.push(await readManifest(id));
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
    }
    return result;
  }

  return {
    enqueueImage: (input) => runExclusive(async () => {
      if (!input.mimeType.startsWith('image/')) throw new Error('attachment must be an image');
      if (input.data.byteLength === 0 || input.data.byteLength > ATTACHMENT_MAX_BYTES) throw new Error('attachment size exceeds limit');
      const targetDeviceIds = validateDeviceIds(input.targetDeviceIds);
      const fileName = validateFileName(input.fileName);
      const existing = (await listManifests()).find((item) => item.clientRequestId === input.clientRequestId && item.senderAgentId === input.senderAgentId);
      if (existing) return existing;
      const attachmentId = `att_${randomUUID()}`;
      const dir = join(outboxDir, attachmentId);
      await mkdir(dir, { recursive: true });
      try {
        const originalPath = assetPath(attachmentId, 'original');
        const previewPath = assetPath(attachmentId, 'preview');
        await writeFile(`${originalPath}.tmp`, input.data);
        await rename(`${originalPath}.tmp`, originalPath);
        const previewTempPath = `${previewPath}.tmp.png`;
        await (options.generatePreview || ((source, output) => makePreview({ source, output, platform })))(originalPath, previewTempPath);
        const preview = await readFile(previewTempPath);
        if (preview.byteLength === 0 || preview.byteLength > ATTACHMENT_PREVIEW_MAX_BYTES) throw new Error('generated preview exceeds limit');
        await rename(previewTempPath, previewPath);
        const created = now();
        const manifest: AttachmentManifest = {
          schemaVersion: 1, attachmentId, kind: 'image', senderAgentId: input.senderAgentId, senderName: input.senderName,
          sourceSession: input.sourceSession?.trim() ? input.sourceSession.trim() : undefined,
          fileName, mimeType: input.mimeType,
          original: { size: input.data.byteLength, sha256: hash(input.data) },
          preview: { fileName: 'preview.png', mimeType: 'image/png', size: preview.byteLength, sha256: hash(preview) },
          message: input.message, clientRequestId: input.clientRequestId, createdAt: new Date(created).toISOString(),
          expiresAt: new Date(created + ATTACHMENT_TTL_MS).toISOString(), status: 'available',
          deliveries: targetDeviceIds.map((targetDeviceId) => ({ targetDeviceId, previewStatus: 'pending', originalStatus: 'pending', attemptCount: 0 })),
        };
        await writeManifest(manifest);
        // eslint-disable-next-line no-console
        console.log(`[zterm:attach] enqueue ok attachmentId=${attachmentId} file=${fileName} targets=${targetDeviceIds.join(',')} session=${input.sourceSession?.trim() || '-'} sender=${input.senderName || input.senderAgentId}`);
        return manifest;
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    }),
    listForDevice: (deviceId, asset = 'preview', includeAcknowledged = false) => runExclusive(async () => {
      const manifests = await listManifests();
      return manifests.filter((item) => item.status === 'available' && now() < Date.parse(item.expiresAt) && item.deliveries.some((delivery) => delivery.targetDeviceId === deviceId && (includeAcknowledged || delivery[asset === 'preview' ? 'previewStatus' : 'originalStatus'] !== 'acknowledged')));
    }),
    readAsset: (attachmentId, asset, deviceId) => runExclusive(async () => {
      const manifest = await readManifest(attachmentId);
      const delivery = manifest.deliveries.find((item) => item.targetDeviceId === deviceId);
      if (!delivery) throw new Error('attachment is not addressed to this device');
      if (manifest.status !== 'available' || now() >= Date.parse(manifest.expiresAt)) throw new Error('attachment expired');
      const data = await readFile(assetPath(attachmentId, asset));
      const expected = asset === 'preview' ? manifest.preview : manifest.original;
      if (data.byteLength !== expected.size || hash(data) !== expected.sha256) throw new Error('attachment integrity check failed');
      return { manifest, data };
    }),
    acknowledge: (attachmentId, deviceId, asset, sha256) => runExclusive(async () => {
      const manifest = await readManifest(attachmentId);
      if (manifest.status !== 'available' || now() >= Date.parse(manifest.expiresAt)) throw new Error('attachment expired');
      const delivery = manifest.deliveries.find((item) => item.targetDeviceId === deviceId);
      if (!delivery) throw new Error('attachment is not addressed to this device');
      const expected = asset === 'preview' ? manifest.preview.sha256 : manifest.original.sha256;
      if (sha256 !== expected) throw new Error('attachment receipt checksum mismatch');
      delivery[asset === 'preview' ? 'previewStatus' : 'originalStatus'] = 'acknowledged';
      delivery.acknowledgedAt = new Date(now()).toISOString();
      await writeManifest(manifest);
      return manifest;
    }),
    cleanup: () => runExclusive(async () => {
      const current = now(); let expired = 0; let deleted = 0;
      for (const manifest of await listManifests()) {
        if (manifest.status === 'available' && current < Date.parse(manifest.expiresAt)) continue;
        expired += manifest.status === 'available' ? 1 : 0;
        await mkdir(tombstoneDir, { recursive: true });
        await writeFile(join(tombstoneDir, `${manifest.attachmentId}.json`), JSON.stringify({ attachmentId: manifest.attachmentId, expiredAt: new Date(current).toISOString() }));
        await rm(join(outboxDir, manifest.attachmentId), { recursive: true, force: true });
        deleted += 1;
      }
      await mkdir(tombstoneDir, { recursive: true });
      for (const fileName of await readdir(tombstoneDir)) {
        if (!fileName.endsWith('.json')) continue;
        const path = join(tombstoneDir, fileName);
        const tombstone = JSON.parse(await readFile(path, 'utf8')) as { expiredAt?: string };
        const expiredAt = Date.parse(tombstone.expiredAt || '');
        if (!Number.isFinite(expiredAt)) throw new Error('invalid attachment tombstone');
        if (current >= expiredAt + ATTACHMENT_TOMBSTONE_TTL_MS) {
          await rm(path);
        }
      }
      return { expired, deleted };
    }),
  };
}
