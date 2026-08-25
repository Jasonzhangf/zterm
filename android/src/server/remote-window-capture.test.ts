import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '@zterm/shared/protocol';
import {
  startScreenCaptureKitFrameSource,
  buildRemoteWindowCaptureUpdateCommand,
  buildScreenCaptureKitConfig,
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

describe('remote-window capture config', () => {
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
});
