import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function extractBlock(source: string, anchor: string, length = 900) {
  const start = source.indexOf(anchor);
  expect(start, `missing block anchor: ${anchor}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('architecture boundary truth gate', () => {
  it('keeps this architecture gate wired into the feature-registry command', () => {
    const packageJson = read('package.json');

    expect(packageJson).toContain('src/lib/architecture-boundary-truth.test.ts');
  });

  it('keeps open-tab core intent policies explicit instead of fallback-named truth', () => {
    const source = read('src/lib/open-tab-intent.ts');

    expect(source).not.toContain('fallbackActiveSessionId');
    expect(source).not.toContain('fallbackSessionIds');
    expect(source).toContain('preserveActiveSessionId');
    expect(source).toContain('nextActiveCandidateSessionIds');
  });

  it('documents the boundary remediation plan as a required architecture input', () => {
    const agents = read('../AGENTS.md');
    const skill = read('../.agents/skills/terminal-buffer-truth/SKILL.md');
    const memory = read('MEMORY.md');

    const remediationPath = 'android/docs/audits/2026-07-02-architecture-boundary-remediation.md';
    expect(agents).toContain(remediationPath);
    expect(skill).toContain('android/docs/audits/2026-07-02-architecture-boundary-remediation.md');
    expect(memory).toContain('2026-07-02-architecture-boundary-remediation.md');
  });

  it('keeps session transport-mode rebuild lifecycle out of App page orchestration', () => {
    const source = read('src/App.tsx');

    expect(source).not.toContain('const handleForceRelaySession = useCallback');
    expect(source).not.toContain('const handleUseAutoSession = useCallback');
    expect(source).not.toContain('app.session.force-relay');
    expect(source).not.toContain('app.session.use-auto');
    expect(source).not.toMatch(/closeSession\(sessionId\)[\s\S]*createSession\([\s\S]*switchSession\(sessionId\)/);
  });

  it('keeps page and terminal UI components from owning session lifecycle primitives', () => {
    const surfaces = [
      'src/App.tsx',
      'src/pages/TerminalPage.tsx',
      'src/components/terminal/TerminalHeader.tsx',
      'src/components/terminal/TerminalSessionDrawer.tsx',
    ];

    for (const relativePath of surfaces) {
      const source = read(relativePath);
      expect(source, relativePath).not.toMatch(/\bcreateSession\s*\(/);
      expect(source, relativePath).not.toMatch(/\bswitchSession\s*\(/);
      expect(source, relativePath).not.toMatch(/\bcloseSession\s*\(/);
    }
  });

  it('keeps TerminalSessionDrawer from inventing host identity fallbacks', () => {
    const source = read('src/components/terminal/TerminalSessionDrawer.tsx');

    expect(source).not.toContain("fallbackKey = 'default'");
    expect(source).not.toContain("hostKey: 'default'");
    expect(source).not.toContain("hostLabel: session.hostLabel || '本机'");
    expect(source).not.toContain('hostLabel: session.hostLabel || "本机"');
    expect(source).toContain('UNSCOPED_HOST_GROUP_KEY');
  });

  it('keeps daemon width ownership limited to the adaptive subscriber lease owner', () => {
    const runtimeTypesSource = stripComments(read('src/server/terminal-runtime-types.ts'));
    const mirrorRuntimeSource = stripComments(read('src/server/terminal-mirror-runtime.ts'));

    expect(runtimeTypesSource).not.toMatch(/interface\s+TerminalTransportSubscriber[\s\S]*\bwidthMode\s*:/);
    expect(runtimeTypesSource).not.toMatch(/interface\s+SessionMirror[\s\S]*\badaptiveCols\s*:/);
    expect(mirrorRuntimeSource).not.toContain('session.widthMode');
    expect(mirrorRuntimeSource).not.toContain('mirror.adaptiveCols');
    expect(mirrorRuntimeSource).not.toMatch(/runTmux\(\s*\[\s*['"]set-window-option['"][\s\S]*['"]window-size['"][\s\S]*['"]latest['"]/);
    expect(mirrorRuntimeSource).not.toContain('function applyAdaptiveColsToTmuxMirror');
    expect(mirrorRuntimeSource).toContain('function applyTmuxWindowGeometry');
    expect(mirrorRuntimeSource).toContain('function updateAdaptiveWidthLease');
    expect(mirrorRuntimeSource).toContain('function reconcileAdaptiveWidthLeases');
    expect(mirrorRuntimeSource).toContain('function releaseAdaptiveWidthLease');
    const adaptiveLeaseResizeBlock = extractBlock(mirrorRuntimeSource, 'function applyTmuxWindowGeometry', 900);
    expect(adaptiveLeaseResizeBlock).toContain("const args = ['resize-window', '-t', mirror.sessionName");
    expect(adaptiveLeaseResizeBlock).toContain('deps.runTmux(args)');
    const mirrorRuntimeWithoutAllowedAdaptiveResize = mirrorRuntimeSource.replace(adaptiveLeaseResizeBlock, '');
    expect(mirrorRuntimeWithoutAllowedAdaptiveResize).not.toMatch(/runTmux\(\s*\[\s*['"]resize-window['"]/);

    expect(runtimeTypesSource).toContain('widthMode?: TerminalWidthMode');
    expect(mirrorRuntimeSource).toMatch(/handleAdaptiveResize\(\s*session: TerminalSession,\s*payload: \{ cols\?: number; widthMode\?:/);
  });

  it('keeps terminal width mode storage owned by bridge settings only', () => {
    expect(existsSync(join(root, 'src/lib/device/TerminalWidthModeManager.ts'))).toBe(false);
    expect(read('src/lib/terminal-width-mode-manager.ts')).not.toContain('localStorage');
    expect(read('../packages/shared/src/react/use-bridge-settings-storage.ts')).toContain('STORAGE_KEYS.BRIDGE_SETTINGS');
  });

  it('keeps daemon attach correlation fields out of daemon-owned token state', () => {
    const messageControlSource = stripComments(read('src/server/terminal-message-control-runtime.ts'));
    const attachTokenSource = stripComments(read('src/server/terminal-attach-token-runtime.ts'));

    expect(messageControlSource).not.toContain('clientSessionId');
    expect(attachTokenSource).not.toContain('clientSessionId');
    expect(attachTokenSource).not.toContain('openRequestId');
    expect(attachTokenSource).toContain('const sessionTransportAttachTokens = new Set<string>()');
    expect(messageControlSource).toContain('openRequestId: payload.openRequestId');
    expect(messageControlSource).toContain('sessionTransportToken');
  });

  it('keeps session websocket reconnect decisions centralized in the transport lifecycle owner', () => {
    const inputRuntimeSource = stripComments(read('src/contexts/session-context-input-runtime.ts'));
    const activityRuntimeSource = stripComments(read('src/contexts/session-context-activity-runtime.ts'));
    const sessionRuntimeSource = stripComments(read('src/contexts/session-context-session-runtime.ts'));
    const transportPlannerSource = stripComments(read('src/contexts/session-transport-open-helpers.ts'));
    const orchestrationSource = stripComments(read('src/contexts/session-context-session-orchestration-runtime.ts'));

    expect(existsSync(join(root, 'src/lib/transport/TransportManager.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/lib/session/SessionConnector.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/lib/session/SessionStore.ts'))).toBe(false);

    expect(inputRuntimeSource).not.toContain('reconnectSession');
    expect(inputRuntimeSource).not.toContain('probeOrReconnect');
    expect(inputRuntimeSource).not.toContain('shouldReconnectQueuedActiveInput');
    expect(inputRuntimeSource).not.toMatch(/cleanupSocket\s*\(/);

    expect(activityRuntimeSource).not.toContain('probeOrReconnect');
    expect(activityRuntimeSource).not.toContain('forceReplaceTransport');
    expect(activityRuntimeSource).not.toContain('active-resume');
    expect(orchestrationSource).not.toContain('probeOrReconnect');
    expect(orchestrationSource).not.toContain('active-resume');

    expect(sessionRuntimeSource).not.toContain('forceReplaceTransport');
    expect(transportPlannerSource).not.toContain('forceReplaceTransport');
    expect(transportPlannerSource).not.toContain('shouldReconnectQueuedActiveInput');
    expect(transportPlannerSource).not.toContain('active-resume');
    expect(transportPlannerSource).not.toContain("'stale-pending-open'");
    expect(transportPlannerSource).not.toContain("'force-replace'");
    expect(transportPlannerSource).toContain("reason: 'pending-open'");
  });

  it('keeps traversal sockets from owning a second default reconnect state machine', () => {
    const source = stripComments(read('src/lib/traversal/socket.ts'));

    expect(source).toContain('this.autoReconnect = options?.autoReconnect === true');
    expect(source).not.toContain('this.autoReconnect = options?.autoReconnect !== false');
  });

  it('keeps the mainline call map free of force-replace lifecycle semantics', () => {
    const callMap = read('docs/wiki/mainline-call-map.json');

    expect(callMap).not.toContain('force replace');
    expect(callMap).not.toContain('force replacement');
    expect(callMap).not.toContain('stale probe timeout');
    expect(callMap).toContain('same-socket head request');
    expect(callMap).toContain('explicit unavailable reconnect intent');
  });
});
