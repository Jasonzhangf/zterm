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

function extractBlock(source: string, anchor: string) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + 1800);
}

describe('server mirror capture truth gates', () => {
  it('keeps server glue delegating mirror capture to the dedicated capture module', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalMirrorCaptureRuntime');
    expect(source).toContain('captureMirrorAuthoritativeBufferFromTmux: terminalMirrorCapture.captureMirrorAuthoritativeBufferFromTmux');
    expect(source).toContain('runTmuxAsync: (args) => terminalControlRuntime.runTmuxAsync(args)');
  });

  it('canonicalizes captured lines directly inside the snapshot capture owner instead of replaying a joined screen snapshot into synthetic scrollback', () => {
    const source = readMirrorCaptureSource();
    const block = extractBlock(source, 'async function captureTmuxMirrorSnapshot');

    expect(block).toContain('canonicalizeCapturedMirrorLines');
    expect(block).toContain('await readTmuxPaneMetricsAsync(mirror.sessionName)');
    expect(block).toContain('await captureTmuxMirrorLinesAsync(metrics.paneId');
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

    const destroyBlock = extractBlock(runtimeSource, 'function destroyMirror');
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
});
