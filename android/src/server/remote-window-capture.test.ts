import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '@zterm/shared/protocol';
import {
  startScreenCaptureKitFrameSource,
  buildRemoteWindowCaptureUpdateCommand,
  buildScreenCaptureKitConfig,
  validateStreamTargetForCapture,
  RemoteWindowCaptureTargetOutOfDisplayError,
  RemoteWindowCaptureTargetUnavailableError,
} from './remote-window-capture';
import { buildRemoteWindowCanvasLayoutV1 } from './remote-window-canvas-layout';
import { SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT } from './remote-window-scripts';

function makeTarget(overrides: Partial<RemoteWindowStreamTargetManifest> = {}): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: 'app-window:1:100',
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.tencent.xinWeChat',
      pid: 100,
      windowId: '100',
      title: 'WeChat',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
    },
    inputTarget: { kind: 'app-window' },
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-08-08T00:00:00.000Z',
    },
    ...overrides,
  } as RemoteWindowStreamTargetManifest;
}

function writeCaptureFixture(directory: string, ack: string) {
  const captureBinary = join(directory, 'capture');
  writeFileSync(captureBinary, `#!/bin/sh
printf '\\132\\122\\127\\061\\002\\000\\000\\000\\002\\000\\000\\000\\020\\000\\000\\000\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014'
while IFS= read -r command; do
  printf '%s\n' 'ZTERM_REMOTE_WINDOW_CAPTURE_UPDATE ${ack}' >&2
done
`);
  chmodSync(captureBinary, 0o755);
  return captureBinary;
}

describe('remote-window capture config', () => {
  it('validates required windows against fresh ScreenCaptureKit truth before spawning the capture child', async () => {
    const validatedWindowIds: string[][] = [];
    const frames: Array<{ width: number }> = [];
    const directory = mkdtempSync(join(tmpdir(), 'rw-capture-validate-'));
    const captureBinary = join(directory, 'capture');
    writeFileSync(captureBinary, `#!/bin/sh
if [ "$1" = "remote-window-validate" ]; then exit 0; fi
printf '\\132\\122\\127\\061\\002\\000\\000\\000\\002\\000\\000\\000\\020\\000\\000\\000\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014\\014'
/bin/sleep 5
`);
    chmodSync(captureBinary, 0o755);
    try {
      const source = await startScreenCaptureKitFrameSource(makeTarget({
        compositeWindows: [{
          windowId: '200',
          title: 'Preview',
          windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
          cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        }],
      }), {
        frameRate: 30,
        startupTimeoutMs: 3_000,
        swiftBinary: '/bin/echo',
        captureBinary,
        validateTargets: async (config) => {
          validatedWindowIds.push([
            config.windowId,
            ...(config.compositeWindows ?? []).map((window) => window.windowId),
          ]);
        },
        onFrame: (frame) => frames.push({ width: frame.width }),
        onError: vi.fn(),
      });

      expect(validatedWindowIds).toEqual([['100', '200']]);
      expect(frames).toContainEqual({ width: 2 });
      source.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a stale window before spawning the capture child', async () => {
    await expect(startScreenCaptureKitFrameSource(makeTarget(), {
      frameRate: 30,
      startupTimeoutMs: 1_000,
      swiftBinary: '/bin/echo',
      captureBinary: '/usr/bin/true',
      validateTargets: async () => {
        throw new RemoteWindowCaptureTargetUnavailableError(['456']);
      },
      onFrame: () => undefined,
      onError: () => undefined,
    })).rejects.toThrow('remote window target not found in fresh SCShareableContent: 456');
  });

  it('rejects a composite window whose frame is outside the captured display before validation or spawn', async () => {
    const validateTargets = vi.fn(async () => undefined);
    const target = makeTarget({
      compositeWindows: [{
        windowId: '200',
        title: 'Preview',
        windowBoundsTopLeftPx: { x: 2694, y: 873, width: 1347, height: 679 },
        cropRectTopLeftPx: { x: 2694, y: 873, width: 1347, height: 679 },
      }],
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        scale: 1,
        displayBoundsTopLeftPx: { x: 0, y: 0, width: 3840, height: 2160 },
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    });

    expect(() => validateStreamTargetForCapture(target))
      .toThrow(RemoteWindowCaptureTargetOutOfDisplayError);
    await expect(startScreenCaptureKitFrameSource(target, {
      frameRate: 30,
      startupTimeoutMs: 1_000,
      swiftBinary: '/bin/echo',
      captureBinary: '/usr/bin/true',
      validateTargets,
      onFrame: () => undefined,
      onError: () => undefined,
    })).rejects.toThrow('remote window target frame is outside display');
    expect(validateTargets).not.toHaveBeenCalled();
  });

  it('keeps validation on the same installed daemon binary and ScreenCaptureKit truth', () => {
    const captureRuntime = readFileSync(join(process.cwd(), 'src/server/remote-window-capture.ts'), 'utf8');
    expect(captureRuntime).toContain("['remote-window-validate', ...windowIds]");
    expect(captureRuntime).toContain('await (options.validateTargets ?? validateScreenCaptureKitTargetWindows)');
    expect(captureRuntime.indexOf('await (options.validateTargets ?? validateScreenCaptureKitTargetWindows)'))
      .toBeLessThan(captureRuntime.indexOf('const child = spawn(options.captureBinary'));
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('func startRemoteWindowValidateProcess');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('remote window target frame is outside display');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('content.displays.first(where: { $0.frame.contains(window.frame) })');
  });

  it('builds a capture config carrying composite windows and canvas size', () => {
    const target = makeTarget({
      compositeWindows: [
        {
          windowId: '200',
          title: 'Preview',
          windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
          cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        },
      ],
    });
    const config = buildScreenCaptureKitConfig(target, 30);
    expect(config.canvasWidth).toBe(1920);
    expect(config.canvasHeight).toBe(1080);
    const layout = buildRemoteWindowCanvasLayoutV1(target, 1)!;
    const mainLayout = layout.windows.find((window) => window.windowId === '100')!;
    const childLayout = layout.windows.find((window) => window.windowId === '200')!;
    expect(config.mainOffsetX).toBe(mainLayout.canvasRectPx.x);
    expect(config.mainOffsetY).toBe(mainLayout.canvasRectPx.y);
    expect(config.outputWidth).toBe(mainLayout.canvasRectPx.width);
    expect(config.outputHeight).toBe(mainLayout.canvasRectPx.height);
    expect(config.compositeWindows).toHaveLength(1);
    expect(config.compositeWindows![0]).toMatchObject({
      windowId: '200',
      offsetX: childLayout.canvasRectPx.x,
      offsetY: childLayout.canvasRectPx.y,
      outputWidth: childLayout.canvasRectPx.width,
      outputHeight: childLayout.canvasRectPx.height,
    });
    expect(childLayout.canvasRectPx.y + childLayout.canvasRectPx.height).toBeLessThanOrEqual(Math.round(1080 * 0.3));
    expect(mainLayout.canvasRectPx.y).toBeGreaterThanOrEqual(Math.round(1080 * 0.3));
  });

  it('keeps the main-window offset in capture update commands', () => {
    const target = makeTarget({
      compositeWindows: [{
        windowId: '200',
        title: 'Preview',
        windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
      }],
    });
    const config = buildScreenCaptureKitConfig(target, 30);
    const command = buildRemoteWindowCaptureUpdateCommand(config, 4);
    expect(command.kind).toBe('update-config');
    expect(command.seq).toBe(4);
    expect(command.mainOffsetX).toBe(config.mainOffsetX);
    expect(command.mainOffsetY).toBe(config.mainOffsetY);
  });

  it('positions the Swift composite main window with the configured offset', () => {
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('let mainOffsetX: Double?');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('let mainOffsetY: Double?');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('offsetX: config.mainOffsetX ?? 0');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('offsetY: config.mainOffsetY ?? 0');
  });

  it('streams ScreenCaptureKit frames without a screenshot-loop fallback', () => {
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('try await stream.startCapture()');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('var activeOutputs: [SCStreamOutput] = []');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('activeOutputs.append(output)');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('streamConfiguration.minimumFrameInterval');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('SCScreenshotManager');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('compositeFrameLoop');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('captureFrameDelayMilliseconds');
  });

  it('updates the existing SCStream configuration and filter without stop/start', () => {
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('func updateCapture(config: CaptureConfig) async throws');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('updateContentFilter(filter)');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('updateConfiguration(streamConfiguration)');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('try await updateCapture(config: nextConfig)');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('try await startCapture(config: nextConfig)');
  });

  it('fails before capture startup when Screen Recording permission is not granted', () => {
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('CGPreflightScreenCaptureAccess()');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('Screen Recording permission is required');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('exit(5)');
  });

  it('fails immediately without requesting, polling, or retrying Screen Recording permission', () => {
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('CGRequestScreenCaptureAccess()');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('permissionDeadline');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('Thread.sleep');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toMatch(/while\s+Date\(\)/u);
  });

  it('requires the installed capture binary instead of falling back to swift -e', async () => {
    await expect(startScreenCaptureKitFrameSource(makeTarget(), {
      frameRate: 30,
      startupTimeoutMs: 20_000,
      swiftBinary: '/bin/echo',
      captureBinary: undefined as unknown as string,
      onFrame: () => undefined,
      onError: () => undefined,
    })).rejects.toThrow('installed ScreenCaptureKit capture binary is required');

    const captureRuntime = readFileSync(join(process.cwd(), 'src/server/remote-window-capture.ts'), 'utf8');
    expect(captureRuntime).toContain('installed ScreenCaptureKit capture binary is required');
    expect(captureRuntime).not.toContain('SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT');
    expect(captureRuntime).not.toContain("'-e'");
  });

  it('keeps a single-window capture config unchanged when no composites', () => {
    const config = buildScreenCaptureKitConfig(makeTarget(), 30);
    expect(config.canvasWidth).toBeUndefined();
    expect(config.compositeWindows).toBeUndefined();
    expect(config.windowId).toBe('100');
  });

  it('bounds a single-window output proportionally without changing its source crop', () => {
    const target = makeTarget({
      videoTarget: {
        ...makeTarget().videoTarget,
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 1920, height: 1080 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 1920, height: 1080 },
      },
    });
    const config = buildScreenCaptureKitConfig(target, 45, {
      maxCaptureWidth: 1280,
      maxCaptureHeight: 800,
    });
    expect(config.cropRect).toEqual({ x: 10, y: 20, width: 1920, height: 1080 });
    expect(config.outputWidth).toBe(1280);
    expect(config.outputHeight).toBe(720);
    expect(config.frameRate).toBe(45);
  });

  it('scales every composite canvas projection field by one common ratio', () => {
    const target = makeTarget({
      compositeWindows: [{
        windowId: '200',
        title: 'Preview',
        windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
      }],
    });
    const natural = buildScreenCaptureKitConfig(target, 30);
    const bounded = buildScreenCaptureKitConfig(target, 30, {
      maxCaptureWidth: 960,
      maxCaptureHeight: 600,
    });
    expect(bounded.canvasWidth).toBe(960);
    expect(bounded.canvasHeight).toBe(540);
    expect(bounded.mainOffsetX).toBe(Math.round((natural.mainOffsetX ?? 0) * 0.5));
    expect(bounded.mainOffsetY).toBe(Math.round((natural.mainOffsetY ?? 0) * 0.5));
    expect(bounded.outputWidth).toBe(Math.round((natural.outputWidth ?? 0) * 0.5));
    expect(bounded.outputHeight).toBe(Math.round((natural.outputHeight ?? 0) * 0.5));
    expect(bounded.compositeWindows?.[0]).toMatchObject({
      offsetX: Math.round((natural.compositeWindows?.[0].offsetX ?? 0) * 0.5),
      offsetY: Math.round((natural.compositeWindows?.[0].offsetY ?? 0) * 0.5),
      outputWidth: Math.round((natural.compositeWindows?.[0].outputWidth ?? 0) * 0.5),
      outputHeight: Math.round((natural.compositeWindows?.[0].outputHeight ?? 0) * 0.5),
    });
  });

  it('commits a changed capture profile only after the in-place update ACK', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rw-capture-profile-'));
    const captureBinary = writeCaptureFixture(directory, '{"seq":1,"ok":true,"width":1280,"height":720}');
    try {
      const source = await startScreenCaptureKitFrameSource(makeTarget(), {
        frameRate: 30,
        maxCaptureWidth: 1920,
        maxCaptureHeight: 1200,
        startupTimeoutMs: 3_000,
        swiftBinary: '/bin/echo',
        captureBinary,
        validateTargets: async () => undefined,
        onFrame: () => undefined,
        onError: vi.fn(),
      });
      await source.updateVideoProfile?.({
        maxFrameRateFps: 45,
        maxCaptureWidth: 1280,
        maxCaptureHeight: 800,
      });
      expect(source).toMatchObject({
        frameRate: 45,
        maxCaptureWidth: 1280,
        maxCaptureHeight: 800,
        width: 1280,
        height: 720,
      });
      await source.updateVideoProfile?.({
        maxFrameRateFps: 45,
        maxCaptureWidth: 1280,
        maxCaptureHeight: 800,
      });
      source.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the applied capture profile unchanged when the in-place update is rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rw-capture-profile-reject-'));
    const captureBinary = writeCaptureFixture(directory, '{"seq":1,"ok":false,"error":"profile rejected"}');
    try {
      const source = await startScreenCaptureKitFrameSource(makeTarget(), {
        frameRate: 30,
        maxCaptureWidth: 1920,
        maxCaptureHeight: 1200,
        startupTimeoutMs: 3_000,
        swiftBinary: '/bin/echo',
        captureBinary,
        validateTargets: async () => undefined,
        onFrame: () => undefined,
        onError: vi.fn(),
      });
      await expect(source.updateVideoProfile?.({
        maxFrameRateFps: 45,
        maxCaptureWidth: 1280,
        maxCaptureHeight: 800,
      })).rejects.toThrow('profile rejected');
      expect(source).toMatchObject({
        frameRate: 30,
        maxCaptureWidth: 1920,
        maxCaptureHeight: 1200,
      });
      source.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
