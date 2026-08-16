import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAttachmentDeliveryRuntime, ATTACHMENT_TTL_MS } from './attachment-delivery-runtime';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRuntime(now = 1_000) {
  const root = await mkdtemp(join(tmpdir(), 'zterm-attachments-'));
  roots.push(root);
  const runtime = createAttachmentDeliveryRuntime({
    rootDir: root,
    now: () => now,
    generatePreview: async (_source, output) => { await import('node:fs/promises').then(({ writeFile }) => writeFile(output, Buffer.from('preview'))); },
  });
  return { runtime, root };
}

describe('attachment delivery runtime', () => {
  it('persists an image with a preview and independent delivery records', async () => {
    const { runtime, root } = await createRuntime();
    const manifest = await runtime.enqueueImage({
      fileName: 'screen.png', mimeType: 'image/png', data: Buffer.from('original'),
      senderAgentId: 'codex', senderName: 'Codex', clientRequestId: 'req-1',
      targetDeviceIds: ['phone-a', 'phone-b'], message: 'failure screenshot',
    });
    expect(manifest.deliveries).toHaveLength(2);
    expect((await runtime.listForDevice('phone-a')).map((item) => item.attachmentId)).toEqual([manifest.attachmentId]);
    expect((await runtime.readAsset(manifest.attachmentId, 'preview', 'phone-a')).data).toEqual(Buffer.from('preview'));
    expect((await readFile(join(root, 'outbox', manifest.attachmentId, 'manifest.json'), 'utf8')).includes('phone-b')).toBe(true);
  });

  it('deduplicates the same agent request without creating another attachment', async () => {
    const { runtime } = await createRuntime();
    const input = { fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'same', targetDeviceIds: ['phone-a'] };
    const first = await runtime.enqueueImage(input);
    const second = await runtime.enqueueImage(input);
    expect(second.attachmentId).toBe(first.attachmentId);
  });

  it('acknowledges one device without consuming another device delivery', async () => {
    const { runtime } = await createRuntime();
    const manifest = await runtime.enqueueImage({ fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'req', targetDeviceIds: ['phone-a', 'phone-b'] });
    await runtime.acknowledge(manifest.attachmentId, 'phone-a', 'preview', manifest.preview.sha256);
    expect(await runtime.listForDevice('phone-a', 'preview')).toEqual([]);
    expect((await runtime.listForDevice('phone-b', 'preview'))[0].attachmentId).toBe(manifest.attachmentId);
    expect((await runtime.listForDevice('phone-a', 'original'))[0].attachmentId).toBe(manifest.attachmentId);
  });

  it('serializes concurrent receipts without losing either device acknowledgement', async () => {
    const { runtime } = await createRuntime();
    const manifest = await runtime.enqueueImage({ fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'req-concurrent-receipt', targetDeviceIds: ['phone-a', 'phone-b'] });
    await Promise.all([
      runtime.acknowledge(manifest.attachmentId, 'phone-a', 'preview', manifest.preview.sha256),
      runtime.acknowledge(manifest.attachmentId, 'phone-b', 'preview', manifest.preview.sha256),
    ]);
    expect(await runtime.listForDevice('phone-a', 'preview')).toEqual([]);
    expect(await runtime.listForDevice('phone-b', 'preview')).toEqual([]);
  });

  it('deduplicates concurrent enqueue requests at the mutation owner', async () => {
    const { runtime, root } = await createRuntime();
    const input = { fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'req-concurrent-enqueue', targetDeviceIds: ['phone-a'] };
    const [first, second] = await Promise.all([runtime.enqueueImage(input), runtime.enqueueImage(input)]);
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(await readdir(join(root, 'outbox'))).toEqual([first.attachmentId]);
  });

  it('removes an unpublished attachment directory when preview generation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zterm-attachments-'));
    roots.push(root);
    const runtime = createAttachmentDeliveryRuntime({
      rootDir: root,
      generatePreview: async (_source, output) => {
        await writeFile(output, Buffer.from('partial'));
        throw new Error('preview failed');
      },
    });
    await expect(runtime.enqueueImage({ fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'req-preview-failure', targetDeviceIds: ['phone-a'] })).rejects.toThrow('preview failed');
    expect(await readdir(join(root, 'outbox'))).toEqual([]);
  });

  it('uses a PNG-suffixed temporary output for cross-platform preview encoders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zterm-attachments-'));
    roots.push(root);
    let previewOutput = '';
    const runtime = createAttachmentDeliveryRuntime({
      rootDir: root,
      platform: 'win32',
      generatePreview: async (_source, output) => {
        previewOutput = output;
        await writeFile(output, Buffer.from('preview'));
      },
    });
    await runtime.enqueueImage({ fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'req-preview-format', targetDeviceIds: ['phone-a'] });
    expect(previewOutput).toMatch(/\.png$/);
  });

  it('rejects non-canonical attachment identifiers before filesystem access', async () => {
    const { runtime } = await createRuntime();
    await expect(runtime.readAsset('../outside', 'preview', 'phone-a')).rejects.toThrow('invalid attachment id');
    await expect(runtime.acknowledge('att_not-a-uuid', 'phone-a', 'preview', 'sha')).rejects.toThrow('invalid attachment id');
  });

  it('cleans attachments after the 48-hour TTL', async () => {
    let now = 1_000;
    const root = await mkdtemp(join(tmpdir(), 'zterm-attachments-'));
    roots.push(root);
    const runtime = createAttachmentDeliveryRuntime({ rootDir: root, now: () => now, generatePreview: async (_source, output) => { await import('node:fs/promises').then(({ writeFile }) => writeFile(output, Buffer.from('preview'))); } });
    const manifest = await runtime.enqueueImage({ fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'req', targetDeviceIds: ['phone-a'] });
    now += ATTACHMENT_TTL_MS + 1;
    expect(await runtime.listForDevice('phone-a')).toEqual([]);
    await expect(runtime.acknowledge(manifest.attachmentId, 'phone-a', 'preview', manifest.preview.sha256)).rejects.toThrow('attachment expired');
    expect(await runtime.cleanup()).toEqual({ expired: 1, deleted: 1 });
    await expect(runtime.readAsset(manifest.attachmentId, 'preview', 'phone-a')).rejects.toThrow('ENOENT');
  });

  it('removes tombstones after their bounded retention window', async () => {
    let now = 1_000;
    const root = await mkdtemp(join(tmpdir(), 'zterm-attachments-'));
    roots.push(root);
    const runtime = createAttachmentDeliveryRuntime({ rootDir: root, now: () => now, generatePreview: async (_source, output) => { await writeFile(output, Buffer.from('preview')); } });
    await runtime.enqueueImage({ fileName: 'a.png', mimeType: 'image/png', data: Buffer.from('a'), senderAgentId: 'agent', senderName: 'Agent', clientRequestId: 'req-tombstone', targetDeviceIds: ['phone-a'] });
    now += ATTACHMENT_TTL_MS + 1;
    await runtime.cleanup();
    expect((await readdir(join(root, 'tombstones'))).length).toBe(1);
    now += 24 * 60 * 60 * 1000 + 1;
    await runtime.cleanup();
    expect(await readdir(join(root, 'tombstones'))).toEqual([]);
  });
});
