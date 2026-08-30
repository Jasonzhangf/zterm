import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function sourceFiles(path: string): string[] {
  const absolute = join(root, path);
  return readdirSync(absolute).flatMap((entry) => {
    const target = join(absolute, entry);
    if (statSync(target).isDirectory()) {
      return sourceFiles(relative(root, target));
    }
    return /\.(?:ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')
      ? [relative(root, target)]
      : [];
  });
}

describe('remote window architecture boundary truth', () => {
  it('keeps one daemon canvas-layout builder and no client layout builder', () => {
    const files = sourceFiles('src');
    const builders = files.filter((path) => read(path).includes('function buildRemoteWindowCanvasLayoutV1'));
    expect(builders).toEqual(['src/server/remote-window-canvas-layout.ts']);
    expect(read('src/components/terminal/RemoteWindowOverlayController.tsx')).not.toContain('buildRemoteWindowCanvasLayout');
    expect(read('src/lib/remote-window-overlay-runtime.ts')).not.toContain('buildRemoteWindowCanvasLayout');
  });

  it('locks gateway composition to dedicated layout, quality, capture, input, and session owners', () => {
    const gateway = read('src/server/remote-window-stream-daemon.ts');
    for (const owner of [
      './remote-window-canvas-layout',
      './remote-window-catalog-runtime',
      './remote-window-quality',
      './remote-window-capture',
      './remote-window-input-helper',
      './remote-window-input-policy',
      './remote-window-stream-session',
    ]) {
      expect(gateway).toContain(owner);
    }
    expect(gateway).toContain('releaseRemoteWindowStreamSessionResources');
    expect(gateway).toContain('validateRemoteWindowInputPayload');
    expect(gateway).toContain('createRemoteWindowCatalogRuntime');
    expect(gateway).not.toContain('remote window click input coordinates are invalid');
    expect(gateway).not.toContain('remote window gesture input contract is invalid');
    expect(gateway).not.toContain('targetCatalogRefreshes');
    expect(gateway).not.toContain('listTargetsLive');
  });

  it('forbids SDP rewrite and local-offer negotiation in the daemon', () => {
    const gateway = read('src/server/remote-window-stream-daemon.ts');
    expect(gateway).toContain('peerConnection.setRemoteDescription');
    expect(gateway).not.toMatch(/offer\.sdp\.(?:replace|split)|rewrite.*sdp|fallbackOffer|createOffer\s*\(/i);
  });

  it('keeps active runtime free of design-only raw/encode resources', () => {
    const activeSource = sourceFiles('src').map((path) => read(path)).join('\n');
    expect(activeSource).not.toContain('resource.remote_window_canvas_raw');
    expect(activeSource).not.toContain('resource.remote_window_canvas_encode');
  });

  it('keeps pointer, decoded-frame, and capture-frame hot paths free of console logging', () => {
    for (const path of [
      'src/components/terminal/RemoteWindowOverlayController.tsx',
      'src/components/terminal/useRemoteWindowPlayback.ts',
      'src/components/terminal/useRemoteWindowCompositeCanvas.ts',
      'src/server/remote-window-stream-daemon.ts',
    ]) {
      expect(read(path)).not.toContain('console.log');
    }
    expect(read('src/components/terminal/useRemoteWindowCompositeCanvas.ts'))
      .not.toContain('requestAnimationFrame');
  });

  it('keeps locked controls and developer diagnostics outside the overlay controller body', () => {
    const facade = read('src/components/terminal/RemoteWindowOverlay.tsx');
    const controller = read('src/components/terminal/RemoteWindowOverlayController.tsx');
    expect(facade.trim().split('\n').length).toBeLessThanOrEqual(10);
    expect(controller.trim().split('\n').length).toBeLessThanOrEqual(3200);
    expect(facade).toContain('RemoteWindowOverlayController as RemoteWindowOverlay');
    expect(controller).toContain('<RemoteWindowLockedToolbar');
    expect(controller).toContain('<RemoteWindowDeveloperDiagnostics');
    expect(controller).not.toContain('data-testid="remote-window-locked-toolbar"');
    expect(controller).not.toContain('data-testid="remote-window-developer-diagnostics"');
    expect(controller).toContain('<RemoteWindowTargetPicker');
    expect(controller).toContain('<RemoteWindowAppSwitch');
    expect(controller).toContain('<RemoteWindowMorePanel');
    expect(controller).toContain('useRemoteWindowQuality');
    expect(controller).toContain('useRemoteWindowPlayback');
    expect(controller).toContain('useRemoteWindowCompositeCanvas');
    expect(controller).toContain('<RemoteWindowVideoContent');
    expect(controller).toContain('useRemoteWindowCatalog');
    expect(controller).toContain('useRemoteWindowViewport');
    expect(controller).toContain('useRemoteWindowFocusSwitch');
    expect(controller).not.toContain('thumbnailInFlightTargetIdsRef');
    expect(controller).not.toContain('REMOTE_WINDOW_THUMBNAIL_REFRESH_INTERVAL_MS');
    expect(controller).not.toContain('beginRemoteWindowQualityRequest');
    expect(controller).not.toContain('resolveRemoteWindowVideoAdaptiveDecision');
    expect(controller).not.toContain('receiverPlaybackBindingRef');
    expect(controller).not.toContain('videoPlaybackStatsRef');
    expect(controller).not.toContain('requestAnimationFrame(draw)');
    expect(controller).not.toContain('data-testid="remote-window-video-wallpaper"');
    expect(controller).not.toContain('catalogWatchdogRef');
    expect(controller).not.toContain('REMOTE_WINDOW_ACTIVE_CATALOG_SYNC_INTERVAL_MS');
    expect(controller).not.toContain('setViewportDebugSnapshot');
    expect(controller).not.toContain('lastAutoFullscreenImePanRef');
    expect(controller).not.toContain('beginRemoteWindowDualStreamSwitch');
    expect(controller).not.toContain('showRemoteWindowOverviewCrop');
    expect(controller).not.toContain('data-testid="remote-window-picker"');
    expect(controller).not.toContain('data-testid="remote-window-active-app-switch-list"');
    expect(controller).not.toContain('data-testid="remote-window-stream-status-panel"');
  });
});
