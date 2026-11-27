import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  AttachedTmuxOperator,
  buildLongInputOracleProbe,
  compareMarkerDelimitedPayload,
  finalizeCase,
  runCodexLiveCase,
} from '../../scripts/daemon-mirror-lab';

const codexPrompt = 'codex-lab %';
const codexOracle = {
  capturedAt: '2026-11-27T00:00:00.000Z',
  capturedAtMonotonicMs: 1,
  captureArgs: [],
  captureWindowStart: 0,
  captureWindowEnd: 0,
  captureAbsoluteStartIndex: 0,
  captureAbsoluteEndIndex: 1,
  rawCapture: `${codexPrompt}\n`,
  captureLines: [codexPrompt],
  sessionName: 'zterm_mirror_lab_test',
  tmuxSocket: '/tmp/zterm_mirror_lab_test/tmux',
  paneId: '%7',
  paneRows: 1,
  paneCols: 80,
  historySize: 0,
  historyLimit: 2048,
  cursorX: codexPrompt.length,
  cursorY: 0,
  cursorVisible: true,
  alternateOn: false,
  paneCommand: 'zsh',
  lines: [codexPrompt],
};
const codexPayload = {
  revision: 1,
  startIndex: 0,
  endIndex: 1,
  availableStartIndex: 0,
  availableEndIndex: 1,
  cols: 80,
  rows: 1,
  cursorKeysApp: false,
  cursor: { rowIndex: 0, col: codexPrompt.length, visible: true },
  lines: [{
    index: 0,
    cells: Array.from(codexPrompt).map((char) => ({
      char: char.codePointAt(0)!,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    })),
  }],
};
const codexHistory = [{ at: '2026-11-27T00:00:00.000Z', type: 'buffer-sync', payload: codexPayload }];
const successfulCodexStep = (label: string) => ({
  label,
  verificationMode: 'source-and-client-render' as const,
  ok: true,
  oracle: codexOracle,
  daemonPayload: codexPayload,
  compare: { ok: true, mismatchIndex: null, expected: [codexPrompt], actual: [codexPrompt] },
  clientMirrorCompare: { ok: true, mismatchIndex: null, expected: [codexPrompt], actual: [codexPrompt] },
  historyLength: 1,
});

describe('strict marker-delimited oracle admission', () => {
  const start = '__start__';
  const end = '__end__';
  const expected = ['first  internal', 'last  '];
  const accepts = (captureLines: string[], payload = expected) =>
    compareMarkerDelimitedPayload({ captureLines }, start, end, payload).ok;

  it('accepts exact contiguous rows and unique ordered markers with outside history', () => {
    expect(accepts(['history', start, ...expected, end, 'prompt'])).toBe(true);
  });

  it('accepts observed 80-column literal space padding without changing expected whitespace', () => {
    expect(accepts([start, ...expected, end].map((row) => row.padEnd(80, ' ')))).toBe(true);
  });

  it.each([
    ['missing start', [...expected, end]],
    ['missing end', [start, ...expected]],
    ['duplicate start before payload', [start, start, ...expected, end]],
    ['duplicate start after block', [start, ...expected, end, start]],
    ['duplicate end before block', [end, start, ...expected, end]],
    ['duplicate end after block', [start, ...expected, end, end]],
    ['reversed markers', [end, ...expected, start]],
    ['embedded start', [`prefix${start}`, ...expected, end]],
    ['partial end', [start, ...expected, end.slice(1)]],
    ['nonblank marker suffix', [`${start}x`, ...expected, end]],
    ['tab marker padding', [start, ...expected, `${end}\t`]],
    ['missing row', [start, expected[0], end]],
    ['duplicate row', [start, expected[0], ...expected, end]],
    ['swapped rows', [start, ...expected.slice().reverse(), end]],
    ['inserted row', [start, expected[0], 'inserted', expected[1], end]],
    ['partial row', [start, expected[0].slice(1), expected[1], end]],
    ['extra payload-like row', [start, ...expected, 'last  extra', end]],
    ['extra prefix control', [start, 'shell control', ...expected, end]],
    ['extra suffix control', [start, ...expected, 'shell control', end]],
    ['extra blank row', [start, ...expected, '', end]],
    ['nonblank payload suffix', [start, `${expected[0]}x`, expected[1], end]],
    ['tab payload padding', [start, `${expected[0]}\t`, expected[1], end]],
    ['missing expected trailing whitespace', [start, expected[0], 'last ', end]],
    ['duplicate full blocks', [start, ...expected, end, start, ...expected, end]],
    ['duplicate payload blocks', [start, ...expected, ...expected, end]],
  ])('rejects %s', (_name, rows) => {
    expect(accepts(rows)).toBe(false);
  });

  it('rejects empty expected payload', () => {
    expect(accepts([start, end], [])).toBe(false);
  });

  it('emits the actual generated command contiguously and exposes file failure', () => {
    const fixture = buildLongInputOracleProbe();
    const caseDir = mkdtempSync(join(tmpdir(), 'zterm-oracle-command-'));
    const localFile = join(caseDir, 'payload.txt');
    try {
      expect(fixture.payloadLines).toHaveLength(1200);
      expect(fixture.fileContent).toBe(`${fixture.payloadLines.join('\n')}\n`);
      expect(fixture.fileContent).not.toContain(fixture.marker);
      const afterEof = fixture.bodyInput.split('\x04')[1];
      expect(afterEof).toBeDefined();
      const commands = afterEof.split('\r').filter(Boolean);
      expect(commands).toHaveLength(1);
      // stty has no terminal in this noninteractive shell. Replace only that
      // external boundary with a shell stub; execute the generated command body.
      const command = commands[0].replaceAll(fixture.filePath, localFile);
      writeFileSync(localFile, fixture.fileContent);
      const run = () => spawnSync('/bin/sh', ['-c', `stty() { :; }; ${command}`], { encoding: 'utf8' });
      const success = run();
      expect(success.status).toBe(0);
      expect(success.stdout).toBe(`${fixture.marker}\n${fixture.fileContent}${fixture.settledMarker}\n`);
      expect(compareMarkerDelimitedPayload(
        { captureLines: success.stdout.trimEnd().split('\n') },
        fixture.marker, fixture.settledMarker, fixture.payloadLines,
      ).ok).toBe(true);
      rmSync(localFile);
      const failure = run();
      expect(failure.status).not.toBe(0);
      expect(failure.stderr).not.toBe('');
      expect(failure.stdout).not.toContain(fixture.settledMarker);
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  });
});

describe('codex-live harness completion and runtime truth', () => {
  it('keeps a runtime failure false even when a second capture matches', async () => {
    const operations = {
      sleep: async () => undefined,
      waitForOracle: async () => codexOracle,
      captureOracleSnapshot: () => codexOracle,
      waitForPayloadToMatchOracle: async () => codexPayload,
    };
    const probe = {
      payload: codexPayload,
      history: codexHistory,
      waitForMarker: async () => codexPayload,
      waitForHistory: async () => codexPayload,
    };

    const result = await runCodexLiveCase(probe, {
      attach: async () => undefined,
      write: () => { throw new Error(`can't find pane: =zterm_mirror_lab_test`); },
    }, operations);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(`can't find pane`);
    expect(result.oracle).toBe(codexOracle);
    expect(result.failureCauses).toEqual([{ stage: 'case', message: `can't find pane: =zterm_mirror_lab_test` }]);
    expect(result.steps?.map((step) => step.label)).toEqual(['codex-shell-visible', 'codex-live-runtime']);
    expect(result.steps?.[0]).toMatchObject({ label: 'codex-shell-visible', ok: true });
  });

  it('cannot pass an incomplete or preserved two-stage codex-live list', () => {
    const visibleOnly = finalizeCase('codex-live', [successfulCodexStep('codex-shell-visible')]);
    const preservedInvalidPass = finalizeCase('codex-live', [
      successfulCodexStep('codex-shell-visible'),
      successfulCodexStep('codex-live-runtime'),
    ]);

    expect(visibleOnly.ok).toBe(false);
    expect(visibleOnly.reason).toContain('codex-shell-local-echo');
    expect(preservedInvalidPass.ok).toBe(false);
    expect(preservedInvalidPass.reason).toContain('codex-shell-tail-refresh');
    expect(finalizeCase('codex-live', []).ok).toBe(false);
    expect(finalizeCase('codex-live', [
      successfulCodexStep('codex-shell-visible'),
      successfulCodexStep('codex-shell-tail-refresh'),
      successfulCodexStep('codex-shell-local-echo'),
    ]).ok).toBe(false);
  });

  it('resolves the native pane and sends text and C-m as separate operations', async () => {
    const calls: string[][] = [];
    const command = (args: string[]) => {
      calls.push(args);
      return args[0] === 'list-panes' ? '%42\n' : '';
    };
    const operator = new AttachedTmuxOperator(command, 'zterm_mirror_lab_test');

    operator.write('printf __pane__\r');

    expect(calls).toEqual([
      ['list-panes', '-t', '=zterm_mirror_lab_test', '-F', '#{pane_id}'],
      ['send-keys', '-t', '%42', '-l', '--', 'printf __pane__'],
      ['send-keys', '-t', '%42', 'C-m'],
    ]);

    const emptyPaneCalls: string[][] = [];
    const emptyPaneOperator = new AttachedTmuxOperator((args) => {
      emptyPaneCalls.push(args);
      return '';
    }, 'zterm_mirror_lab_test');
    expect(() => emptyPaneOperator.write('must-not-send')).toThrow('(empty)');
    expect(emptyPaneCalls).toHaveLength(1);
  });

  it('retains the three ordered successful codex-live stages', async () => {
    const operations = {
      sleep: async () => undefined,
      waitForOracle: async () => codexOracle,
      captureOracleSnapshot: () => codexOracle,
      waitForPayloadToMatchOracle: async () => codexPayload,
    };
    const probe = {
      payload: codexPayload,
      history: codexHistory,
      waitForMarker: async () => codexPayload,
      waitForHistory: async () => codexPayload,
    };

    const result = await runCodexLiveCase(probe, {
      attach: async () => undefined,
      write: () => undefined,
    }, operations);

    expect(result.ok).toBe(true);
    expect(result.steps?.map((step) => [step.label, step.ok])).toEqual([
      ['codex-shell-visible', true],
      ['codex-shell-local-echo', true],
      ['codex-shell-tail-refresh', true],
    ]);
  });

  it('preserves completed stages and the newest oracle when tail settling throws', async () => {
    const tailOracle = { ...codexOracle, capturedAtMonotonicMs: 3 };
    let observations = 0;
    let settlements = 0;
    const result = await runCodexLiveCase({
      payload: codexPayload,
      history: codexHistory,
      waitForMarker: async () => codexPayload,
      waitForHistory: async () => codexPayload,
    }, {
      attach: async () => undefined,
      write: () => undefined,
    }, {
      sleep: async () => undefined,
      waitForOracle: async () => ++observations === 3 ? tailOracle : codexOracle,
      waitForPayloadToMatchOracle: async () => {
        if (++settlements === 2) throw new Error('tail settle failed first');
        return codexPayload;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tail settle failed first');
    expect(result.oracle).toBe(tailOracle);
    expect(result.steps?.map((step) => [step.label, step.ok])).toEqual([
      ['codex-shell-visible', true],
      ['codex-shell-local-echo', true],
      ['codex-live-runtime', false],
    ]);
  });
});

describe('daemon mirror lab isolation gate', () => {
  it('uses an isolated managed-daemon test port instead of the user configured service port', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain('ZTERM_TEST_DAEMON_PORT');
    expect(script).toContain('MANAGED_DAEMON_TEST_PORT');
    expect(script).not.toContain("process.env.ZTERM_PORT || config.port || 45761");
    expect(script).toContain("String(daemonController?.getPort() || MANAGED_DAEMON_TEST_PORT || config.port)");
  });

  it('starts the owned server child through the tsx loader without a tsx CLI wrapper', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("const tsxLoader = pathToFileURL(join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;");
    expect(script).toContain("spawn(process.execPath, ['--import', tsxLoader, 'src/server/server.ts']");
    expect(script).not.toContain("spawn(process.execPath, [tsxBin, 'src/server/server.ts']");
  });

  it('replays client mirror history with revision-reset aware helper', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'client-mirror-replay.ts'), 'utf8');
    expect(script).toContain("import { replayBufferSyncHistory } from '../src/lib/terminal-buffer-replay'");
    expect(script).toContain('replayBufferSyncHistory({');
    expect(script).not.toContain('buffer = applyBufferSyncToSessionBuffer(buffer, item.payload');
  });

  it('fails replay when any intermediate source-to-client comparison fails', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'client-mirror-replay.ts'), 'utf8');
    expect(script).toContain('ok: finalCheck.ok && stepChecks.every((step) => step.ok)');
    expect(script).toContain("verificationMode: 'source-and-client-render' as const");
    expect(script).toContain('if (!result.ok)');
    expect(script).not.toContain('if (mismatchIndex !== null)');
  });

  it('requires each intermediate step to declare whether client rendering is part of its gate', () => {
    const labScript = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    const replayScript = readFileSync(join(process.cwd(), 'scripts', 'client-mirror-replay.ts'), 'utf8');
    expect(labScript).toContain("verificationMode: 'source-only' | 'source-and-client-render'");
    expect(labScript).toContain("verificationMode: 'source-only'");
    expect(labScript).toContain("verificationMode: 'source-and-client-render'");
    expect(replayScript).toContain("const clientRenderRequired = step.verificationMode === 'source-and-client-render'");
    expect(replayScript).toContain('validVerificationMode && (!clientRenderRequired || stepMismatchIndex === null)');
    expect(labScript).toContain("const scheduleFireStep = buildStepResult(");
    expect(labScript).not.toContain("label: 'schedule-fire-marker-in-daemon-buffer',\n    verificationMode: 'source-and-client-render',\n    ok: true");
  });

  it('exits nonzero only when a declared client-render step diverges', () => {
    const caseDir = mkdtempSync(join(tmpdir(), 'zterm-client-replay-'));
    const payload = {
      revision: 1,
      startIndex: 0,
      endIndex: 1,
      availableStartIndex: 0,
      availableEndIndex: 1,
      cols: 80,
      rows: 1,
      cursorKeysApp: false,
      cursor: null,
      lines: [{
        index: 0,
        cells: Array.from('new').map((char) => ({
          char: char.codePointAt(0),
          fg: 256,
          bg: 256,
          flags: 0,
          width: 1,
        })),
      }],
    };
    const runReplay = (verificationMode: 'source-only' | 'source-and-client-render') => {
      writeFileSync(join(caseDir, 'probe-history.json'), JSON.stringify([{
        at: '2026-07-28T00:00:00.000Z',
        type: 'buffer-sync',
        payload,
      }]));
      writeFileSync(join(caseDir, 'tmux-capture.txt'), 'new\n');
      writeFileSync(join(caseDir, 'tmux-metrics.txt'), 'rows=1\ncols=80\n');
      writeFileSync(join(caseDir, 'step-results.json'), JSON.stringify([{
        label: 'intermediate-observation',
        verificationMode,
        historyLength: 1,
        oracle: { paneRows: 1, paneCols: 80, lines: ['old'] },
      }]));
      return spawnSync(
        process.execPath,
        [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/client-mirror-replay.ts', caseDir],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
    };

    try {
      const sourceOnly = runReplay('source-only');
      expect(sourceOnly.status).toBe(0);
      expect(JSON.parse(sourceOnly.stdout).stepChecks[0]).toMatchObject({
        verificationMode: 'source-only',
        ok: true,
        mismatchIndex: 0,
      });
      expect(JSON.parse(sourceOnly.stdout).finalCheck).toEqual({
        verificationMode: 'source-and-client-render',
        ok: true,
        mismatchIndex: null,
      });

      const clientRender = runReplay('source-and-client-render');
      expect(clientRender.status).toBe(1);
      expect(JSON.parse(clientRender.stdout).stepChecks[0]).toMatchObject({
        verificationMode: 'source-and-client-render',
        ok: false,
        mismatchIndex: 0,
      });
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  });

  it('waits for codex shell payload to settle to tmux truth instead of comparing the first marker frame', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain('async function waitForPayloadToMatchOracle(');
    expect(script).toContain("'codex shell marker settled payload'");
    expect(script).toContain("'codex shell tail settled payload'");
  });

  it('waits for daemon-restart command payload to settle after the marker echo appears', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("'daemon restart before settled payload'");
    expect(script).toContain("'daemon restart after settled payload'");
    expect(script).toContain("'daemon restart after marker reflects'");
  });

  it('waits for external-input payloads to settle to tmux truth instead of sampling the first marker frame', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("'external-input-a settled payload'");
    expect(script).toContain("'external-input-b settled payload'");
    expect(script).toContain("'external-input-tail settled payload'");
  });

  it('compares daemon payload and replayed client history independently for sparse visible windows', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    const buildStepBlock = script.slice(
      script.indexOf('function buildStepResult('),
      script.indexOf('function finalizeCase('),
    );
    expect(buildStepBlock).toContain('const compare = compareTail(oracle, daemonPayload);');
    expect(buildStepBlock).toContain('const clientMirrorCompare = replayClientMirrorCompare(oracle, history.slice(0, historyLength));');
    expect(buildStepBlock).toContain('const ok = compare.ok && clientMirrorCompare.ok;');
    expect(buildStepBlock).not.toContain('payloadCoversVisibleViewport');
  });

  it('uses replay-history waits for settled oracle matching after a later sparse diff changes the last payload', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    const waitForOraclePayloadBlock = script.slice(
      script.indexOf('async function waitForPayloadToMatchOracle('),
      script.indexOf('class AttachedTmuxOperator'),
    );
    expect(script).toContain('async waitForHistory(label: string, predicate: () => boolean');
    expect(waitForOraclePayloadBlock).toContain('return probe.waitForHistory(');
    expect(waitForOraclePayloadBlock).toContain('compareTail(oracle, probe.payload).ok');
    expect(waitForOraclePayloadBlock).toContain('&& replayClientMirrorCompare(oracle, probe.history).ok');
    expect(waitForOraclePayloadBlock).not.toContain('return probe.waitForPayload(');
  });

  it('waits for markers in replayed client mirror history instead of only the latest sparse payload', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    const waitForMarkerBlock = script.slice(
      script.indexOf('async waitForMarker('),
      script.indexOf('sendMessage(message: ClientMessage)'),
    );
    expect(script).toContain('private historyText()');
    expect(waitForMarkerBlock).toContain('return this.waitForHistory(');
    expect(waitForMarkerBlock).toContain('() => this.historyText().includes(marker)');
    expect(waitForMarkerBlock).not.toContain('normalizeWireLines(payload.lines');
  });

  it('keeps long-input source capture and settled mirror recovery as separate black-box gates', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    const sourceStepBlock = script.slice(
      script.indexOf('function buildLongInputSourceStep('),
      script.indexOf('function finalizeCase('),
    );
    const settledStepBlock = script.slice(
      script.indexOf('function buildLongInputSettledStep('),
      script.indexOf('function finalizeLongInputCase('),
    );
    expect(sourceStepBlock).toContain("'long-input-source-target-payload'");
    expect(sourceStepBlock).toContain("verificationMode: 'source-only'");
    expect(sourceStepBlock).toContain('compareMarkerDelimitedPayload(');
    expect(settledStepBlock).toContain("'long-input-settled-daemon-client-windows'");
    expect(settledStepBlock).toContain("verificationMode: 'source-and-client-render'");
    expect(settledStepBlock).toContain('compareSettledDaemonWindow(oracle, payload)');
    expect(settledStepBlock).toContain('compareSettledClientWindow(oracle, payload, history)');
    expect(settledStepBlock).toContain('daemonCompare.ok && clientCompare.ok');
  });

  it('waits for top/vim exit payloads to settle to tmux truth after alternate-screen returns to shell', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("'top enter settled payload'");
    expect(script).toContain("'top continued settled payload'");
    expect(script).toContain("'top-enter-continued-refresh'");
    expect(script).toContain("'top exit settled payload'");
    expect(script).toContain("'vim exit settled payload'");
  });

  it('waits for probe transport detach before killing the fixed lab session during teardown', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain('async close()');
    expect(script).toContain('await probe?.close();');
    expect(script.indexOf('operator?.close();')).toBeLessThan(script.indexOf('await probe?.close();'));
    expect(script.indexOf('await probe?.close();')).toBeLessThan(script.indexOf('cleanupLabSession();'));
  });
});
