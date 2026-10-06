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

  it('forbids SDP rewrite while allowing standard sender-owned offer negotiation', () => {
    const gateway = read('src/server/remote-window-stream-daemon.ts');
    expect(gateway).toContain('peerConnection.setRemoteDescription');
    expect(gateway).not.toMatch(/offer\.sdp\.(?:replace|split)|rewrite.*sdp|fallbackOffer/i);
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
    expect(read('src/components/terminal/useRemoteWindowCompositeCanvas.ts'))
      .not.toContain('requestVideoFrameCallback');
    expect(read('src/components/terminal/useRemoteWindowPlayback.ts'))
      .toContain("lane: 'focus'");
    expect(read('src/components/terminal/useRemoteWindowPlayback.ts'))
      .toContain("lane: 'overview'");
  });

  it('keeps locked controls and developer diagnostics outside the overlay controller body', () => {
    const facade = read('src/components/terminal/RemoteWindowOverlay.tsx');
    const controller = read('src/components/terminal/RemoteWindowOverlayController.tsx');
    expect(facade.trim().split('\n').length).toBeLessThanOrEqual(10);
    expect(controller.trim().split('\n').length).toBeLessThanOrEqual(3250);
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

  it('keeps the explicit Mbps cap on the committed render path with no lagging ref', () => {
    const controls = read('src/components/terminal/useRemoteWindowDisplayQualityControls.ts');
    const controller = read('src/components/terminal/RemoteWindowOverlayController.tsx');
    const compact = (source: string) => source.replace(/\s+/g, ' ');
    // The explicit Mbps cap keeps its single owner helper, and the hook derives
    // the Bps cap on the render path rather than through a post-commit ref.
    expect(compact(controls)).toContain(
      'resolveRemoteWindowVideoCapBps(qualitySettings.maxBitrateCapMbps)',
    );
    // Follow the value, not the name. The exported hook field is a contract, so
    // resolve the local identifier it is destructured into and require the two
    // consumers to pass that render-path binding. A renamed local that is really
    // a `.current` read then fails these assertions instead of slipping through.
    const hookCall = controller.match(/const\s*\{([^}]*)\}\s*=\s*useRemoteWindowDisplayQualityControls\(/);
    expect(hookCall).not.toBeNull();
    const destructured = hookCall![1].split(',').map((entry) => entry.trim()).filter(Boolean);
    const localNameFor = (exported: string) => {
      for (const entry of destructured) {
        const match = entry.match(/^(\w+)(?:\s*:\s*(\w+))?$/);
        if (match && match[1] === exported) return match[2] ?? match[1];
      }
      return null;
    };
    const capLocal = localNameFor('maxBitrateCapBps');
    expect(capLocal, 'controller must destructure maxBitrateCapBps from the hook').toBeTruthy();

    // The hook must bind the exported cap value directly to the owner helper
    // on the render path, never through a `.current` read, whatever the local
    // bound to the helper result is called.
    const hookDerivation = compact(controls).match(
      /const maxBitrateCapBps = .*resolveRemoteWindowVideoCapBps\(\s*\w+(?:\.\w+)*\s*\);/,
    );
    expect(hookDerivation, 'hook must derive the Bps cap via the owner helper').not.toBeNull();
    const hookDerivedNames = new Set<string>(['maxBitrateCapBps']);
    for (const match of controls.matchAll(/const\s+(\w+)\s*=\s*[^;]*resolveRemoteWindowVideoCapBps\(/g)) {
      hookDerivedNames.add(match[1]!);
    }
    for (const match of controls.matchAll(/useRef(?:<[^>]*>)?\(\s*(\w+)\b/g)) {
      expect(hookDerivedNames.has(match[1]!), `hook ref created from cap value: ${match[1]}`).toBe(false);
    }
    for (const match of controls.matchAll(/\.current\s*=\s*(\w+)\b/g)) {
      expect(hookDerivedNames.has(match[1]!), `hook ref synced from cap value: ${match[1]}`).toBe(false);
    }

    // Any identifier bound to a `.current` read is a lagging value; the cap
    // binding must never be one of them.
    const refReadBindings = new Set<string>();
    for (const match of controller.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*\.current\b/g)) {
      refReadBindings.add(match[1]!);
    }
    expect(refReadBindings.has(capLocal!)).toBe(false);

    // No ref may be initialized or synced from the cap value or its aliases.
    const aliases = new Set<string>([capLocal!]);
    for (const match of controller.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*;/g)) {
      if (aliases.has(match[2]!)) aliases.add(match[1]!);
    }
    for (const match of controller.matchAll(/useRef(?:<[^>]*>)?\(\s*(\w+)\b/g)) {
      expect(aliases.has(match[1]!), `ref created from cap value: ${match[1]}`).toBe(false);
    }
    for (const match of controller.matchAll(/\.current\s*=\s*(\w+)\b/g)) {
      expect(aliases.has(match[1]!), `ref synced from cap value: ${match[1]}`).toBe(false);
    }

    // The live quality request reads the hook's derived value positionally, and
    // the start profile derives its own cap through the same owner helper.
    expect(capLocal).toBe('maxBitrateCapBps');
    expect(compact(controller)).toContain('maxBitrateCapBps, maxFrameRateFps:');
    expect(compact(controller)).toContain('maxBitrateCapBps: resolveRemoteWindowVideoCapBps(');
  });

});
