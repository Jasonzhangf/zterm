import { describe, expect, it } from 'vitest';
import {
  compilePhase0,
  compilePhase2,
  compilePhase3,
  compilePhase4,
  compilePhase5,
  readDagpipeInputChunks,
  runBufferManagement,
  runBufferRender,
  runConnectionLifecycle,
  runInputDispatch,
  runPhase2Relay,
  runPhase2DaemonConnection,
  runPhase3InputSchedule,
  runPhase3FileBrowse,
  runPhase3Upload,
  runPhase3Download,
  runPhase3Attachment,
  runPhase3Screenshot,
  runPhase4RemoteWindow,
  runPhase5ShellLifecycle,
  runPhase5PreviewLattice,
} from './dagpipe-bridge';

function cell(ch: string) {
  return {
    char: ch.codePointAt(0) ?? 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function line(text: string, index = 0) {
  return { index, cells: Array.from(text).map(cell) };
}

describe('dagpipe native bridge', () => {
  it('compiles all Phase0 graphs from the native core', () => {
    expect(compilePhase0()).toEqual({
      ok: true,
      graphs: [
        'android.connection_lifecycle@0.1',
        'android.buffer_management@0.1',
        'android.buffer_render@0.1',
        'android.input_dispatch@0.1',
        'daemon.mirror_publish@0.2',
        'daemon.control_dispatch@0.1',
      ],
    });
  });

  it('compiles Phase2 relay and daemon connection catalog graphs', () => {
    expect(compilePhase2()).toEqual({
      ok: true,
      graphs: [
        'relay.account_peer_route@0.1',
        'daemon.connection_channel_catalog@0.1',
      ],
    });
  });

  it('compiles Phase3 input, file, attachment and screenshot graphs', () => {
    expect(compilePhase3()).toEqual({
      ok: true,
      graphs: [
        'daemon.input_schedule@0.1',
        'daemon.file_transfer_browse@0.1',
        'daemon.file_transfer_upload@0.1',
        'daemon.file_transfer_download@0.1',
        'daemon.attachment_delivery@0.1',
        'terminal.remote_screenshot@0.1',
      ],
    });
  });

  it('compiles Phase4 remote window stream overlay graph', () => {
    expect(compilePhase4()).toEqual({
      ok: true,
      graphs: ['remote.window_stream_overlay@0.1'],
    });
  });

  it('compiles Phase5 session shell preview graph', () => {
    expect(compilePhase5()).toEqual({
      ok: true,
      graphs: [
        'android.session_shell_lifecycle@0.1',
        'android.session_preview_lattice@0.1',
      ],
    });
  });

  it('routes remote window overlay projections through native core', () => {
    const result = runPhase4RemoteWindow({
      execution_id: 'bridge-phase4-stream',
      attempt_id: '1',
      inputs: {
        'arc.catalog_request': {
          requestId: 'c1',
          windows: [{ id: 'w1', name: 'Terminal' }],
        },
        'arc.stream_start_intent': { requestId: 's1', targetId: 'w1' },
        'arc.touch_action': { kind: 'tap', x: 10, y: 20 },
        'arc.quality_intent': { targetId: 'w1', mode: 'balanced' },
        'arc.stream_policy': { allowStream: true, allowQuality: true, fps: 30 },
      },
    });
    const outputs = (result as { outputs: Record<string, { state: string }> }).outputs;
    expect(outputs['arc.overlay_projection'].state).toBe('projected');
    expect(outputs['arc.input_result'].state).toBe('injected');
  });

  it('routes Phase5 shell lifecycle projections through native core', () => {
    const result = runPhase5ShellLifecycle({
      execution_id: 'bridge-phase5-shell',
      attempt_id: '1',
      inputs: {
        'arc.open_tab_intent': { sessionId: 's1' },
        'arc.shell_state': { visible: true },
      },
    });
    const outputs = (result as { outputs: Record<string, { state: string }> }).outputs;
    expect(outputs['arc.shell_projection'].state).toBe('projected');
    expect(outputs['arc.quickbar_projection'].state).toBe('projected');
  });

  it('routes Phase5 preview lattice select and pan without forced join', () => {
    const result = runPhase5PreviewLattice({
      execution_id: 'bridge-phase5-preview',
      attempt_id: '1',
      inputs: {
        'arc.preview_open_intent': {
          sessionId: 's1',
          cells: [{ cellId: 'c1', sessionId: 's1' }],
        },
        'arc.preview_select': {},
        'arc.focus_pan': { direction: 'right' },
      },
    });
    const outputs = (result as { outputs: Record<string, { state: string }> }).outputs;
    expect(outputs['arc.focus_selection'].state).toBe('skipped');
    expect(outputs['arc.focus_panned'].state).toBe('applied');
  });

  it('routes Phase3 input/schedule and transfer projections through native core', () => {
    const schedule = runPhase3InputSchedule({
      execution_id: 'bridge-phase3-input',
      attempt_id: '1',
      inputs: {
        'arc.channel_input_event': { channelId: 'chan-1', inputId: 'i-1', text: 'ls\r' },
        'arc.input_policy': {},
        'arc.schedule_policy': { enabled: true },
        'arc.schedule_source': { jobs: [{ jobId: 'j-1' }] },
      },
    });
    const write = (schedule as { outputs: Record<string, { state: string }> })
      .outputs['arc.backend_write_result'];
    expect(write.state).toBe('written');

    const browse = runPhase3FileBrowse({
      execution_id: 'bridge-phase3-browse',
      attempt_id: '1',
      inputs: {
        'arc.file_browse_request': { path: '/tmp', entries: [{ name: 'a.txt' }] },
        'arc.fs_permission_policy': { allowRead: true },
      },
    });
    const view = (browse as { outputs: Record<string, { view: { cwd: string } }> })
      .outputs['arc.file_browser_view'];
    expect(view.view.cwd).toBe('/tmp');

    const upload = runPhase3Upload({
      execution_id: 'bridge-phase3-upload',
      attempt_id: '1',
      inputs: {
        'arc.upload_intent': { uploadId: 'up-1', segmentIndex: 1 },
        'arc.transfer_policy': { allowUpload: true },
      },
    });
    expect(
      (upload as { outputs: Record<string, { complete: boolean }> })
        .outputs['arc.upload_complete'].complete,
    ).toBe(true);

    const download = runPhase3Download({
      execution_id: 'bridge-phase3-download',
      attempt_id: '1',
      inputs: {
        'arc.download_intent': { downloadId: 'dl-1', path: '/tmp/a.txt' },
        'arc.transfer_policy': { allowDownload: true },
      },
    });
    expect(
      (download as { outputs: Record<string, { complete: boolean }> })
        .outputs['arc.download_complete'].complete,
    ).toBe(true);

    const attachment = runPhase3Attachment({
      execution_id: 'bridge-phase3-attachment',
      attempt_id: '1',
      inputs: {
        'arc.attachment_delivery_request': {
          attachmentId: 'att-1',
          targetDeviceId: 'dev-1',
        },
        'arc.attachment_policy': { allowDelivery: true },
      },
    });
    expect(
      (attachment as { outputs: Record<string, { state: string }> })
        .outputs['arc.attachment_delivery_result'].state,
    ).toBe('published');

    const screenshot = runPhase3Screenshot({
      execution_id: 'bridge-phase3-screenshot',
      attempt_id: '1',
      inputs: {
        'arc.screenshot_request': { sessionId: 'sess-1' },
        'arc.screenshot_permission': { allowScreenshot: true },
      },
    });
    expect(
      (screenshot as { outputs: Record<string, { state: string }> })
        .outputs['arc.screenshot_result'].state,
    ).toBe('ready');
  });

  it('routes relay login to a resume plan through the native core', () => {
    const result = runPhase2Relay({
      execution_id: 'bridge-phase2-relay',
      attempt_id: '1',
      inputs: {
        'arc.account_credentials': { accountId: 'u1', authToken: 'tok' },
        'arc.relay_settings': { relayEnabled: true },
        'arc.device_capabilities': {
          deviceId: 'device-a',
          platform: 'android',
          routes: ['relay'],
        },
        'arc.route_policy': { pathPriority: ['relay'] },
      },
    });
    const resume = (result as { outputs: Record<string, { state: string; action: string }> })
      .outputs['arc.resume_plan'];
    expect(resume.state).toBe('ready');
    expect(resume.action).toBe('resume');
  });

  it('builds daemon connection catalog and idle facts', () => {
    const result = runPhase2DaemonConnection({
      execution_id: 'bridge-phase2-daemon',
      attempt_id: '1',
      inputs: {
        'arc.physical_connection': { connectionId: 'conn-1' },
        'arc.mux_capabilities': { muxEnabled: true },
        'arc.session_catalog_request': { sessionNames: [{ sessionId: 's1' }] },
        'arc.idle_facts_request': {},
      },
    });
    const catalog = (result as { outputs: Record<string, { state: string }> })
      .outputs['arc.session_catalog'];
    const idle = (result as { outputs: Record<string, { state: string }> })
      .outputs['arc.idle_facts'];
    expect(catalog.state).toBe('ready');
    expect(idle.state).toBe('published');
  });

  it('routes committed text through the input dispatch graph', () => {
    const result = runInputDispatch({
      execution_id: 'bridge-input',
      attempt_id: '1',
      inputs: {
        'arc.committed_text': { text: 'ab\r\ncd' },
        'arc.input_policy': { chunkBytes: 64, maxInFlight: 8 },
        'arc.transport_facts': { state: 'ready', bufferedBytes: 0 },
      },
    });
    const send = (result as { outputs: Record<string, { sends: Array<{ payload: { data: string } }> }> })
      .outputs['arc.mux_channel_send'];
    expect(send.sends[0]?.payload.data).toBe('ab cd');
  });

  it('plans every UTF-8 chunk without dropping beyond maxInFlight', () => {
    const text = 'a'.repeat(80_000);
    const result = runInputDispatch({
      execution_id: 'bridge-input-large',
      attempt_id: '1',
      inputs: {
        'arc.committed_text': { text },
        'arc.input_policy': { chunkBytes: 64 * 1024, maxInFlight: text.length + 1 },
        'arc.transport_facts': { state: 'ready', bufferedBytes: 0 },
      },
    });
    const chunks = readDagpipeInputChunks(result);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });

  it('applies a complete buffer frame and projects DOM rows', () => {
    const result = runBufferRender({
      execution_id: 'bridge-render',
      attempt_id: '1',
      inputs: {
        'arc.daemon_wire_frame': {
          revision: 3,
          startIndex: 0,
          endIndex: 2,
          rows: 24,
          cols: 80,
          lines: [line('a', 0), line('b', 1)],
          cursor: null,
          cursorKeysApp: false,
        },
        'arc.visible_range_demand': {
          startIndex: 0,
          endIndex: 2,
          viewportRows: 24,
          mode: 'follow',
        },
        'arc.local_sparse_state': { startIndex: 0, endIndex: 0, gapRanges: [] },
        'arc.buffer_policy': {},
      },
    });
    const dom = (result as { outputs: Record<string, { rows: string[]; revision: number }> })
      .outputs['arc.dom_commit'];
    expect(dom.rows).toEqual(['a', 'b']);
    expect(dom.revision).toBe(3);
  });

  it('keeps inactive sessions out of render scope', () => {
    const result = runBufferManagement({
      execution_id: 'bridge-buffer',
      attempt_id: '1',
      inputs: {
        'arc.daemon_head_facts': {
          sessions: [{ sessionId: 's1', revision: 1, latestEndIndex: 5 }],
        },
        'arc.session_buffer_demand': {
          sessions: [{ sessionId: 's1', mode: 'inactive' }],
        },
        'arc.local_buffer_state': {
          sessions: [{ sessionId: 's1', revision: 0, startIndex: 0, endIndex: 0 }],
        },
        'arc.buffer_policy': { cacheLines: 100 },
      },
    });
    const scopes = (result as { outputs: Record<string, { scopes: Array<{ visible: boolean }> }> })
      .outputs['arc.render_scope'].scopes;
    expect(scopes[0]?.visible).toBe(false);
  });

  it('plans recovery without dropping sessions', () => {
    const result = runConnectionLifecycle({
      execution_id: 'bridge-connection',
      attempt_id: '1',
      inputs: {
        'arc.account_credentials': { accountId: 'u1', authToken: 'tok' },
        'arc.relay_settings': { relayEnabled: true },
        'arc.target_candidates': {
          candidates: [{ id: 'lan', path: 'LAN', endpoint: '10.0.0.1' }],
        },
        'arc.session_demand_set': {
          sessions: [
            { sessionId: 's1', sessionName: 'one' },
            { sessionId: 's2', sessionName: 'two' },
          ],
        },
        'arc.connection_policy': {
          pathPriority: ['LAN', 'UDP direct', 'Tailscale', 'Relay'],
          expectedGeneration: 1,
        },
      },
    });
    const plan = (result as {
      outputs: Record<string, { recoveryNeeded: boolean; preserveSessions: boolean }>;
    }).outputs['arc.recovery_plan'];
    expect(plan.recoveryNeeded).toBe(false);
    expect(plan.preserveSessions).toBe(true);
  });
});
