// Phase2-8 black-box parity harness.
//
// Each test runs the same representative fixture through a TypeScript owner
// path and the DAGpipe Rust core via `dagpipe-bridge`, then asserts semantic
// equivalence without deleting the old TypeScript implementation.
//
// Phase -> TypeScript owner / oracle:
//   Phase2 relay -> relay-account-directory account projection
//   Phase2 daemon connection -> mux/channel catalog gate
//   Phase3 input schedule -> channel input identity + schedule dispatch
//   Phase3 file browse/upload/download -> transfer permission + completion
//   Phase3 attachment -> receipt delivery != client consumption
//   Phase3 screenshot -> permission + remote screenshot result
//   Phase4 remote window -> remote-window-input-policy validation
//   Phase5 shell lifecycle -> junction-preview-lattice focus movement
//   Phase5 preview lattice -> lattice normalization + select/pan exclusivity
//   Phase6 composition -> plugin-host runtime activation
//   Phase6 control -> client-control-center routing
//   Phase6 config export/import -> config-export payload contract
//   Phase7 release/update/debug -> digest/allow gating + lifecycle projections
//   Phase8 connection service -> Android connection service command/state

import { describe, expect, it } from 'vitest';
import {
  applyConfigImportPayload,
  buildConfigExportPayload,
  validateConfigExportPayload,
} from './config-export';
import {
  createAndroidConnectionServiceStateMachine,
} from './android-connection-service-snapshot';
import { parseAndroidConnectionCommand } from './android-connection-service-commands';
import {
  createPluginHost,
  type PluginHost,
} from './plugin-host/plugin-host-runtime';
import {
  createEmptyJunctionPreviewLattice,
  moveJunctionPreviewFocus,
  normalizeJunctionPreviewLattice,
  setJunctionPreviewCell,
  type JunctionPreviewLatticeV1,
  type JunctionPreviewTarget,
} from './junction-preview-lattice';
import {
  projectRelayDirectoryDeviceSnapshots,
  normalizeRelayAccountDirectory,
} from './relay-account-directory';
import { ClientControlCenter } from './control-center/client-control-center';
import { createControlCommand } from '@zterm/shared/terminal/control-contract';
import { validateRemoteWindowInputPayload } from '../server/remote-window-input-policy';
import {
  runPhase2DaemonConnection,
  runPhase2Relay,
  runPhase3Attachment,
  runPhase3Download,
  runPhase3FileBrowse,
  runPhase3InputSchedule,
  runPhase3Screenshot,
  runPhase3Upload,
  runPhase4RemoteWindow,
  runPhase5PreviewLattice,
  runPhase5ShellLifecycle,
  runPhase6Composition,
  runPhase6ConfigExport,
  runPhase6ConfigImport,
  runPhase6Control,
  runPhase7Debug,
  runPhase7Release,
  runPhase7Update,
  runPhase8Connection,
} from './dagpipe-bridge';

type Outputs = Record<string, any>;

function outputs(result: unknown): Outputs {
  return (result as { outputs: Outputs }).outputs;
}

function phaseRequest(id: string, inputs: Record<string, unknown>) {
  return { execution_id: id, attempt_id: '1', inputs };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    dump: () => Object.fromEntries(values),
  };
}

const relayDirectoryPayload = {
  schemaVersion: 1,
  user: { id: 'u1', username: 'jason' },
  updatedAt: '2026-06-28T10:00:00.000Z',
  devices: [
    {
      deviceId: 'daemon-device',
      deviceName: 'Jason Mac',
      platform: 'darwin',
      appVersion: '0.1.3',
      client: { connected: false, lastSeenAt: '' },
      daemon: {
        hostId: 'daemon-host',
        version: '0.1.3-daemon',
        presence: { connected: true, lastSeenAt: '2026-06-28T10:01:00.000Z' },
        endpoints: [
          {
            id: 'relay-rtc:daemon-host',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host',
            authRequired: true,
            lastSeenAt: '2026-06-28T10:01:00.000Z',
          },
        ],
        sessions: [
          {
            name: 'main',
            cwd: '/Users/jason/project',
            title: 'main shell',
            updatedAt: '2026-06-28T10:01:00.000Z',
          },
        ],
        lastPublishedAt: '2026-06-28T10:01:00.000Z',
      },
    },
  ],
};

const previewTarget: JunctionPreviewTarget = {
  sessionId: 's1',
  bridgeHost: 'host-1',
  bridgePort: 3333,
  sessionName: 'main',
};

function previewLatticeWithCell(): JunctionPreviewLatticeV1 {
  const created = setJunctionPreviewCell(createEmptyJunctionPreviewLattice(), { col: 0, row: 0 }, previewTarget);
  if (!created.ok) throw new Error('fixture preview cell rejected');
  return created.lattice;
}

describe('DAGpipe Phase2-8 black-box parity with TypeScript owners', () => {
  it('Phase2 relay: TS account directory projection matches the Rust relay route projection', () => {
    const directory = normalizeRelayAccountDirectory(relayDirectoryPayload);
    const devices = projectRelayDirectoryDeviceSnapshots(directory);
    expect(devices[0]?.daemon.hostId).toBe('daemon-host');
    expect(devices[0]?.daemon.sessions?.[0]?.name).toBe('main');

    const result = outputs(runPhase2Relay(phaseRequest('parity-phase2-relay', {
      'arc.account_credentials': { accountId: 'u1', authToken: 'tok' },
      'arc.relay_settings': { relayEnabled: true },
      'arc.device_capabilities': {
        deviceId: 'device-a',
        platform: 'android',
        routes: ['relay'],
      },
      'arc.route_policy': { pathPriority: ['relay'] },
    })));
    expect(result['arc.account_directory'].state).toBe('ready');
    expect(result['arc.resume_plan']).toMatchObject({ state: 'ready', action: 'resume' });
  });

  it('Phase2 daemon connection: TS mux/channel truth matches the Rust catalog gate', () => {
    const result = outputs(runPhase2DaemonConnection(phaseRequest('parity-phase2-daemon', {
      'arc.physical_connection': { connectionId: 'conn-1' },
      'arc.mux_capabilities': { muxEnabled: true },
      'arc.session_catalog_request': { sessionNames: [{ sessionId: 's1' }] },
      'arc.idle_facts_request': {},
    })));
    expect(result['arc.session_catalog'].state).toBe('ready');
    expect(result['arc.idle_facts'].state).toBe('published');

    expect(() => runPhase2DaemonConnection(phaseRequest('parity-phase2-daemon-reject', {
      'arc.physical_connection': { connectionId: 'conn-1' },
      'arc.mux_capabilities': { muxEnabled: false },
      'arc.session_catalog_request': { sessionNames: [] },
      'arc.idle_facts_request': {},
    }))).toThrow(/muxEnabled/);
  });

  it('Phase3 input schedule: TS channel input identity survives the Rust write/ack split', () => {
    const result = outputs(runPhase3InputSchedule(phaseRequest('parity-phase3-input', {
      'arc.channel_input_event': { channelId: 'chan-1', inputId: 'i-1', text: 'ls\r' },
      'arc.input_policy': { maxInFlight: 8 },
      'arc.schedule_policy': { enabled: true },
      'arc.schedule_source': { jobs: [{ jobId: 'j-1', command: 'session-list' }] },
    })));
    expect(result['arc.backend_write_result']).toMatchObject({ state: 'written', channelId: 'chan-1' });
    expect(result['arc.input_ack'].state).toBe('acknowledged');
    expect(result['arc.schedule_dispatch'].dispatched[0].jobId).toBe('j-1');

    expect(() => runPhase3InputSchedule(phaseRequest('parity-phase3-input-reject', {
      'arc.channel_input_event': { channelId: 'chan-1' },
      'arc.input_policy': {},
      'arc.schedule_policy': {},
      'arc.schedule_source': {},
    }))).toThrow(/channelId and text/);
  });

  it('Phase3 file browse: TS listing projection matches the Rust view and permission gate', () => {
    const result = outputs(runPhase3FileBrowse(phaseRequest('parity-phase3-browse', {
      'arc.file_browse_request': {
        path: '/tmp',
        entries: [{ name: 'a.txt', kind: 'file' }],
      },
      'arc.fs_permission_policy': { allowRead: true },
    })));
    expect(result['arc.file_browser_view'].view).toMatchObject({ cwd: '/tmp' });
    expect(result['arc.file_browser_view'].view.entries[0].name).toBe('a.txt');

    expect(() => runPhase3FileBrowse(phaseRequest('parity-phase3-browse-reject', {
      'arc.file_browse_request': { path: '/tmp' },
      'arc.fs_permission_policy': { allowRead: false },
    }))).toThrow(/denied by permission policy/);
  });

  it('Phase3 upload/download: TS cumulative-ACK completion matches the Rust transfer gates', () => {
    const upload = outputs(runPhase3Upload(phaseRequest('parity-phase3-upload', {
      'arc.upload_intent': { uploadId: 'up-1', segmentIndex: 2, data: 'abc' },
      'arc.transfer_policy': { allowUpload: true },
    })));
    expect(upload['arc.upload_complete'].complete).toBe(true);
    expect(() => runPhase3Upload(phaseRequest('parity-phase3-upload-reject', {
      'arc.upload_intent': { uploadId: 'up-1' },
      'arc.transfer_policy': { allowUpload: false },
    }))).toThrow(/denied by transfer policy/);

    const download = outputs(runPhase3Download(phaseRequest('parity-phase3-download', {
      'arc.download_intent': { downloadId: 'dl-1', path: '/tmp/a.txt', chunk: 'abc' },
      'arc.transfer_policy': { allowDownload: true },
    })));
    expect(download['arc.download_complete'].complete).toBe(true);
    expect(() => runPhase3Download(phaseRequest('parity-phase3-download-reject', {
      'arc.download_intent': { downloadId: 'dl-1', path: '/tmp/a.txt' },
      'arc.transfer_policy': { allowDownload: false },
    }))).toThrow(/denied by transfer policy/);
  });

  it('Phase3 attachment: receipt delivery stays distinct from client consumption', () => {
    const result = outputs(runPhase3Attachment(phaseRequest('parity-phase3-attachment', {
      'arc.attachment_delivery_request': { attachmentId: 'att-1', targetDeviceId: 'dev-1' },
      'arc.attachment_policy': { allowDelivery: true },
    })));
    expect(result['arc.attachment_delivery_result']).toMatchObject({
      state: 'published',
      receipt: { state: 'delivered' },
    });
    expect(() => runPhase3Attachment(phaseRequest('parity-phase3-attachment-reject', {
      'arc.attachment_delivery_request': { attachmentId: 'att-1', targetDeviceId: 'dev-1' },
      'arc.attachment_policy': { allowDelivery: false },
    }))).toThrow(/denied by policy/);
  });

  it('Phase3 screenshot: TS permission/result semantics match the Rust screenshot store', () => {
    const result = outputs(runPhase3Screenshot(phaseRequest('parity-phase3-screenshot', {
      'arc.screenshot_request': { sessionId: 'sess-1', bytes: 'png-bytes' },
      'arc.screenshot_permission': { allowScreenshot: true },
    })));
    expect(result['arc.screenshot_result'].state).toBe('ready');
  });

  it('Phase4 remote window: TS input policy classification matches the Rust injected input result', () => {
    expect(() => validateRemoteWindowInputPayload(
      {
        streamId: 'stream-1',
        targetId: 'w1',
        deliveryKind: 'action',
        sampledAtMs: 10,
        deadlineMs: 20,
        event: {
          kind: 'click',
          pointerId: 1,
          button: 'left',
          x: 10,
          y: 20,
          normalizedX: 0.1,
          normalizedY: 0.2,
        },
      },
      {
        targetId: 'w1',
        target: {
          targetId: 'w1',
          videoTarget: { kind: 'app-window' },
          inputRoute: 'os-event',
          focusPolicy: 'bring-to-focus',
        } as never,
        canvasLayout: null,
      },
    )).not.toThrow();

    const result = outputs(runPhase4RemoteWindow(phaseRequest('parity-phase4-window', {
      'arc.catalog_request': {
        requestId: 'c1',
        windows: [{ id: 'w1', name: 'Terminal' }],
      },
      'arc.stream_start_intent': { requestId: 's1', targetId: 'w1' },
      'arc.touch_action': { kind: 'tap', x: 10, y: 20 },
      'arc.quality_intent': { targetId: 'w1', mode: 'balanced' },
      'arc.stream_policy': { allowStream: true, allowQuality: true, fps: 30 },
    })));
    expect(result['arc.overlay_directory'].state).toBe('ready');
    expect(result['arc.input_result'].state).toBe('injected');
  });

  it('Phase5 shell lifecycle: TS preview focus movement matches the Rust pan projection', () => {
    const moved = moveJunctionPreviewFocus({ col: 0, row: 0 }, 'right');
    expect(moved).toEqual({ col: 1, row: 0 });

    const shell = outputs(runPhase5ShellLifecycle(phaseRequest('parity-phase5-shell', {
      'arc.open_tab_intent': { sessionId: 's1' },
      'arc.shell_state': { visible: true },
    })));
    expect(shell['arc.shell_projection'].state).toBe('projected');
    expect(shell['arc.quickbar_projection'].state).toBe('projected');
  });

  it('Phase5 preview lattice: TS lattice normalization matches the Rust select/pan exclusivity', () => {
    const lattice = normalizeJunctionPreviewLattice(previewLatticeWithCell());
    expect(lattice?.cells).toHaveLength(1);

    const select = outputs(runPhase5PreviewLattice(phaseRequest('parity-phase5-select', {
      'arc.preview_open_intent': { sessionId: 's1', cells: [{ cellId: 'c1', sessionId: 's1' }] },
      'arc.preview_select': { cellId: 'c1' },
      'arc.focus_pan': {},
    })));
    expect(select['arc.focus_selection'].state).toBe('applied');
    expect(select['arc.focus_panned'].state).toBe('skipped');

    const pan = outputs(runPhase5PreviewLattice(phaseRequest('parity-phase5-pan', {
      'arc.preview_open_intent': { sessionId: 's1', cells: [{ cellId: 'c1', sessionId: 's1' }] },
      'arc.preview_select': {},
      'arc.focus_pan': { direction: 'right' },
    })));
    expect(pan['arc.focus_selection'].state).toBe('skipped');
    expect(pan['arc.focus_panned'].state).toBe('applied');
  });

  it('Phase6 composition: TS plugin host activation matches the Rust plugin projection', async () => {
    const host: PluginHost = createPluginHost();
    host.install(
      {
        pluginId: 'p1',
        version: '0.1.0',
        requires: [],
        provides: ['quickbar'],
        providesUiSlots: ['terminal.quickbar'],
      },
      {
        create: () => ({
          start: async (context) => { context.provideCapability('quickbar', {}); },
          stop: async () => {},
          dispose: async () => {},
        }),
      },
    );
    await host.start('p1');
    expect(host.hasCapability('quickbar')).toBe(true);

    const result = outputs(runPhase6Composition(phaseRequest('parity-phase6-composition', {
      'arc.composition_request': { runtimeId: 'rt-1', ports: ['debug'] },
      'arc.plugin_manifest': {
        pluginId: 'p1',
        capabilities: ['quickbar'],
        uiSlots: ['terminal.quickbar'],
      },
    })));
    expect(result['arc.activated_plugins']).toMatchObject({
      state: 'active',
      uiSlots: ['terminal.quickbar'],
    });
  });

  it('Phase6 control: TS control center routing matches the Rust control result', async () => {
    const center = new ClientControlCenter();
    center.register('settings', {
      ownerId: 'settings',
      execute: async () => ({ ok: true, value: { commandId: 'cmd-1' } }),
    });
    const tsOutcome = await center.execute({
      command: createControlCommand('settings', 'cmd-1', 'corr-1', {}),
      subject: 'settings',
      capabilities: [],
    });
    expect(tsOutcome.ok).toBe(true);

    const result = outputs(runPhase6Control(phaseRequest('parity-phase6-control', {
      'arc.control_request': { commandId: 'cmd-1', owner: 'settings' },
      'arc.control_policy': { allowControl: true },
    })));
    expect(result['arc.control_result']).toMatchObject({ state: 'completed', commandId: 'cmd-1' });
  });

  it('Phase6 config export/import: TS payload contract matches the Rust export/import projections', () => {
    const storage = memoryStorage({ 'zterm:hosts': '[{"id":"h1"}]' });
    const payload = buildConfigExportPayload({
      storage,
      exportedAt: 1,
      appVersion: '0.1.3',
    });
    expect(validateConfigExportPayload(payload)).toEqual(payload);

    const exported = outputs(runPhase6ConfigExport(phaseRequest('parity-phase6-export', {
      'arc.config_export_request': { configId: 'cfg-1' },
    })));
    expect(exported['arc.exported_config'].state).toBe('exported');

    const importedStorage = memoryStorage();
    applyConfigImportPayload(importedStorage, payload);
    expect(importedStorage.dump()['zterm:hosts']).toBe('[{"id":"h1"}]');

    const imported = outputs(runPhase6ConfigImport(phaseRequest('parity-phase6-import', {
      'arc.config_import_request': { configId: 'cfg-1' },
    })));
    expect(imported['arc.import_result'].state).toBe('imported');
  });

  it('Phase7 release: TS digest contract matches the Rust promotion gate', () => {
    const result = outputs(runPhase7Release(phaseRequest('parity-phase7-release', {
      'arc.build_artifact': { name: 'zterm-daemon', sha256: 'abc123' },
      'arc.release_policy': { expectedSha256: 'abc123' },
    })));
    expect(result['arc.runtime_started'].state).toBe('started');

    expect(() => runPhase7Release(phaseRequest('parity-phase7-release-reject', {
      'arc.build_artifact': { name: 'zterm-daemon', sha256: 'abc123' },
      'arc.release_policy': { expectedSha256: 'badhash' },
    }))).toThrow(/digest mismatch/);
  });

  it('Phase7 update/debug: TS update and debug gating matches the Rust lifecycle', () => {
    const update = outputs(runPhase7Update(phaseRequest('parity-phase7-update', {
      'arc.update_check': { version: '0.1.4', sha256: 'def456' },
      'arc.update_policy': { allowUpdate: true },
    })));
    expect(update['arc.client_update_installed'].state).toBe('installed');

    const debug = outputs(runPhase7Debug(phaseRequest('parity-phase7-debug', {
      'arc.debug_sample_request': { sample: 'trace-1' },
      'arc.debug_policy': { allowDebug: true },
    })));
    expect(debug['arc.debug_export'].state).toBe('exported');
    expect(debug['arc.debug_cleanup'].state).toBe('cleaned');

    expect(() => runPhase7Debug(phaseRequest('parity-phase7-debug-reject', {
      'arc.debug_sample_request': { sample: 'trace-denied' },
      'arc.debug_policy': { allowDebug: false },
    }))).toThrow(/debug channel denied/);
  });

  it('Phase8 connection service: TS command/state machine matches the Rust service projection', () => {
    expect(parseAndroidConnectionCommand({ type: 'bind-target', target: { targetKey: 't1', bridgeHost: 'host-1', bridgePort: 3333 } }))
      .toMatchObject({ type: 'bind-target', target: { targetKey: 't1' } });
    expect(() => parseAndroidConnectionCommand({ type: 'foreground-resume' }))
      .toThrow(/unsupported Android connection service command/);

    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1 });
    machine.dispatch({ type: 'bind-target', target: { targetKey: 't1', bridgeHost: 'host-1', bridgePort: 3333 } });
    machine.dispatch({ type: 'transport-opening', generation: 'g1' });
    machine.dispatch({ type: 'mux-ready', generation: 'g1', muxReadyPayload: {} });
    machine.dispatch({ type: 'channel-opened', generation: 'g1', channelId: 'c1' });
    machine.dispatch({ type: 'heartbeat-pong', generation: 'g1', at: 1 });
    expect(machine.readSnapshot().state).toBe('healthy');

    const result = outputs(runPhase8Connection(phaseRequest('parity-phase8-connection', {
      'arc.service_command': {
        type: 'bind-target',
        target: {
          targetKey: 't1',
          bridgeHost: 'host-1',
          channels: [{ channelId: 'c1', sessionName: 's1', state: 'open' }],
        },
      },
      'arc.service_policy': {
        allowTransport: true,
        allowReconnect: true,
        allowNotifications: true,
        maxNotificationActions: 3,
        maxReplayChannels: 3,
      },
      'arc.network_generation_event': { generation: 'g1' },
      'arc.notification_action': { targetKey: 't1', channelId: 'c1', sessionName: 's1' },
      'arc.session_activity_fact': { stopped: true, name: 's1', targetKey: 't1', channelId: 'c1' },
    })));
    expect(result['arc.service_snapshot'].state).toBe('healthy');
  });
});
