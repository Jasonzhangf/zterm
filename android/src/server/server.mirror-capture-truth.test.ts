import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readMirrorCaptureSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-mirror-capture.ts'), 'utf8');
}

function readMirrorRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-mirror-runtime.ts'), 'utf8');
}

function readSnapshotReadSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-snapshot-read-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 1800) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

function extractFunctionBlock(source: string, anchor: string) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  const boundaries = [
    source.indexOf('\n  function ', start + anchor.length),
    source.indexOf('\n  async function ', start + anchor.length),
  ].filter((index) => index >= 0);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : source.length;
  return source.slice(start, end);
}

describe('server mirror capture truth gates', () => {
  it('keeps server glue delegating mirror capture to the dedicated capture module', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalMirrorCaptureRuntime');
    expect(source).toContain('captureMirrorAuthoritativeBufferFromTmux: terminalMirrorCapture.captureMirrorAuthoritativeBufferFromTmux');
    expect(source).toContain('captureSessionSnapshot: (session) => terminalMirrorCapture.captureResolvedSessionSnapshot(session)');
    expect(source).toContain('runTmuxAsyncForSession: (args, sessionName) => terminalControlRuntime.runTmuxAsyncForSession(args, sessionName)');
    expect(source).toContain('runTmuxAsyncForTarget: (args, target) => terminalControlRuntime.runTmuxAsyncForTarget(args, target)');
  });

  it('canonicalizes captured lines directly inside the snapshot capture owner instead of replaying a joined screen snapshot into synthetic scrollback', () => {
    const source = readMirrorCaptureSource();
    const block = extractFunctionBlock(source, 'async function captureTmuxMirrorSnapshot');
    const finalizeBlock = extractFunctionBlock(source, 'async function finalizeTmuxMirrorCapture');

    expect(finalizeBlock).toContain('canonicalizeCapturedMirrorLines');
    expect(block).toContain('await readTmuxPaneMetricsAsync(mirror.sessionName)');
    expect(block).toContain('await captureTmuxMirrorLinesAsync(mirror.sessionName, metrics.paneId');
    expect(block).toContain('finalizeTmuxMirrorCapture({');
    expect(block).not.toContain("writeString(capturedLines.join('\\r\\n'))");
    expect(block).not.toContain('getScrollbackCount()');
    expect(block).not.toContain('readScrollbackRangeByOldestIndex(');
  });

  it('keeps mirror content and geometry writes owned by tmux capture readback only', () => {
    const captureSource = readMirrorCaptureSource();
    const runtimeSource = readMirrorRuntimeSource();

    const captureApplyBlock = extractBlock(captureSource, 'function applyMirrorCaptureSnapshot');
    expect(captureApplyBlock).toContain('mirror.rows = snapshot.rows');
    expect(captureApplyBlock).toContain('mirror.cols = snapshot.cols');
    expect(captureApplyBlock).toContain('mirror.bufferStartIndex = snapshot.bufferStartIndex');
    expect(captureApplyBlock).toContain('mirror.bufferLines = snapshot.bufferLines');
    expect(captureApplyBlock).toContain('mirror.cursor = snapshot.cursor');

    const destroyBlock = extractFunctionBlock(runtimeSource, 'function destroyMirror(');
    const runtimeWithoutDestroyedCleanup = runtimeSource.replace(destroyBlock, '');
    expect(runtimeWithoutDestroyedCleanup).not.toMatch(/\bmirror\.(?:rows|cols|bufferStartIndex|bufferLines|cursor)\s*=/);

    const syncBlock = extractBlock(runtimeSource, 'async function syncMirrorCanonicalBuffer');
    expect(syncBlock).toContain('deps.captureMirrorAuthoritativeBufferFromTmux(mirror)');
    expect(syncBlock).not.toMatch(/\bmirror\.(?:rows|cols|bufferStartIndex|bufferLines|cursor)\s*=/);

    const attachBlock = extractBlock(runtimeSource, 'async function attachTmux');
    expect(attachBlock).not.toContain('mirror.cols =');
    expect(attachBlock).not.toContain('mirror.rows =');
    expect(attachBlock).not.toContain('writeMirrorBaselineGeometry(mirror, existingTmuxGeometry)');
  });

  it('keeps one-shot preview capture on the resolved native target without name routing', () => {
    const source = readMirrorCaptureSource();
    const oneShotBlock = extractBlock(source, 'async function captureResolvedSessionSnapshot', 3200);
    const metricsBlock = extractFunctionBlock(source, 'async function readTmuxPaneMetricsAsync');
    const cursorBlock = extractFunctionBlock(source, 'async function readTmuxCursorStateAsync');
    const captureBlock = extractFunctionBlock(source, 'async function captureTmuxMirrorLinesAsync');

    expect(oneShotBlock).toContain('readTmuxPaneMetricsAsync(target)');
    expect(oneShotBlock).toContain('readTmuxCursorStateAsync(target, metrics.paneId)');
    expect(oneShotBlock).toContain('captureTmuxMirrorLinesAsync(target, metrics.paneId');
    expect(oneShotBlock).not.toContain('runTmuxAsyncForSession');
    expect(oneShotBlock).not.toContain('readExistingMirror');
    expect(metricsBlock).toContain('resolveAsyncTmuxRunner(route)');
    expect(metricsBlock).toContain('buildExactTmuxPaneTarget(route)');
    expect(metricsBlock).toContain('route.sessionId');
    expect(cursorBlock).toContain('resolveAsyncTmuxRunner(route)');
    expect(cursorBlock).toContain('paneTarget');
    expect(captureBlock).toContain('resolveAsyncTmuxRunner(route)');
    expect(captureBlock).toContain('paneTarget');
    expect(source).not.toContain('readTmuxPaneMetricsForTargetAsync');
    expect(source).not.toContain('readTmuxCursorStateForTargetAsync');
    expect(source).not.toContain('captureTmuxMirrorLinesForTargetAsync');
  });

  it('keeps snapshot reads asynchronous, fresh-capture based, and free of ready-mirror-only gating', () => {
    const source = readSnapshotReadSource();

    expect(source).toContain('captureSessionSnapshot');
    expect(source).toContain('await deps.captureSessionSnapshot(session)');
    expect(source).toContain('postCaptureResolution');
    expect(source).not.toContain('readExistingMirror');
    expect(source).not.toContain('mirror_not_present');
    expect(source).not.toContain('mirror_not_ready');
  });
});
