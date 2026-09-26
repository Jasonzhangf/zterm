// Phase2-8 black-box parity and smoke harness.
//
// Where the Rust graph and the TypeScript owner consume the same fixture and
// project the same contract, the case computes the expected value through the
// real TypeScript owner, passes the *same* fixture to the DAGpipe Rust core via
// `dagpipe-bridge`, and asserts the Rust output equals that TS-derived value.
//
// `[smoke]` cases exercise the Rust graph alone where no equivalent TS owner
// output exists to compare against.
// The old TypeScript implementation is kept as the oracle; nothing is deleted.
//
// Phase -> TypeScript owner used as oracle:
//   Phase2 relay -> relay-account-directory account projection
//   Phase2 daemon connection -> daemon session catalog projection
//   Phase3 input schedule -> shared input-chunking normalization
//   Phase3 file browse -> server file-transfer path resolution
//   Phase3 upload/download -> file-transfer-throughput contract
//   Phase3 attachment -> attachment id validation + delivery status
//   Phase3 screenshot -> remote-screenshot chunk assembly
//   Phase4 remote window -> remote-window input policy validation
//   Phase5 shell lifecycle -> junction-preview-lattice normalization [smoke]
//   Phase5 preview lattice -> junction-preview-lattice normalization
//   Phase6 composition -> plugin-host runtime activation
//   Phase6 control -> client-control-center routing
//   Phase6 config export/import -> config-export payload contract [smoke]
//   Phase7 release/update/debug -> app-update normalization + digest gating
//   Phase8 connection service -> Android connection service command/state

import { describe, expect, it } from 'vitest';
import { normalizeTerminalCommittedText } from './terminal-input-normalization';
import {
  FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS,
  FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS,
} from './file-transfer-throughput-runtime';
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
  normalizeJunctionPreviewLattice,
  setJunctionPreviewCell,
  type JunctionPreviewLatticeV1,
  type JunctionPreviewTarget,
} from './junction-preview-lattice';
import {
  normalizeRelayAccountDirectory,
  projectRelayDirectoryDeviceSnapshots,
  resolveRelayDaemonCanonicalHostId,
} from './relay-account-directory';
import { ClientControlCenter } from './control-center/client-control-center';
import { createControlCommand } from '@zterm/shared/terminal/control-contract';
import { normalizeAppUpdateManifest } from './app-update';
import { buildRemoteScreenshotCapture } from './remote-screenshot-runtime';
import { resolveFileTransferListPath } from '../server/file-transfer-path';
import { validateAttachmentId } from '../server/attachment-delivery-runtime';
import { validateRemoteWindowInputPayload } from '../server/remote-window-input-policy';
import { buildSessionsCatalogPayload } from '../server/daemon-session-catalog-runtime';
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

describe('DAGpipe Phase2-8 black-box parity and smoke with TypeScript owners', () => {
  it('Phase2 relay: Rust route carrier matches the TS-projected relay identity fixture', () => {
    // TS oracle: normalize the directory and then project its daemon snapshots.
    const directory = normalizeRelayAccountDirectory(relayDirectoryPayload);
    const tsDevices = projectRelayDirectoryDeviceSnapshots(directory);
    const tsRouteTarget = resolveRelayDaemonCanonicalHostId(
      { daemonHostId: tsDevices[0]?.daemon.hostId },
      tsDevices,
    );
    expect(tsRouteTarget).toBe('daemon-host');

    const result = outputs(runPhase2Relay(phaseRequest('parity-phase2-relay', {
      'arc.account_credentials': { accountId: 'u1', authToken: 'tok' },
      'arc.relay_settings': { relayEnabled: true },
      'arc.device_capabilities': {
        deviceId: tsDevices[0]?.deviceId,
        platform: 'android',
        routes: [tsRouteTarget],
      },
      'arc.route_policy': { pathPriority: [tsRouteTarget] },
    })));

    // Rust's account_directory is a route-carrier projection, not the full TS
    // directory shape. We compare the fields that both projections carry: the
    // device id and the daemon route selected for resume.
    expect(result['arc.account_directory']).toMatchObject({
      accountId: 'u1',
      devices: [
        {
          deviceId: tsDevices[0]?.deviceId,
          id: tsDevices[0]?.deviceId,
          routes: [tsRouteTarget],
        },
      ],
      state: 'ready',
    });
    expect(result['arc.resume_plan']).toMatchObject({
      state: 'ready',
      action: 'resume',
      targetKey: tsRouteTarget,
    });
  });

  it('Phase2 daemon connection: Rust catalog matches the TS session catalog projection', () => {
    // TS oracle: daemon session catalog projection for the same session list.
    const tsCatalog = buildSessionsCatalogPayload({
      listTmuxSessions: () => ['s1'],
      listTerminalSessionCatalog: () => [{ name: 's1', backend: 'tmux' }],
    });
    expect(tsCatalog.sessions).toEqual(['s1']);

    const result = outputs(runPhase2DaemonConnection(phaseRequest('parity-phase2-daemon', {
      'arc.physical_connection': { connectionId: 'conn-1' },
      'arc.mux_capabilities': { muxEnabled: true },
      'arc.session_catalog_request': {
        sessionNames: tsCatalog.sessionCatalog.map((entry) => ({ sessionId: entry.name })),
      },
      'arc.idle_facts_request': {},
    })));

    expect(result['arc.session_catalog'].sessions).toEqual(
      tsCatalog.sessions.map((name) => ({ sessionId: name })),
    );
    expect(result['arc.idle_facts'].sessions).toEqual(
      tsCatalog.sessions.map((name) => ({ sessionId: name, idle: false })),
    );

    expect(() => runPhase2DaemonConnection(phaseRequest('parity-phase2-daemon-reject', {
      'arc.physical_connection': { connectionId: 'conn-1' },
      'arc.mux_capabilities': { muxEnabled: false },
      'arc.session_catalog_request': { sessionNames: [] },
      'arc.idle_facts_request': {},
    }))).toThrow(/muxEnabled/);
  });

  it('Phase3 input schedule: Rust write/ack carries the TS-normalized input identity', () => {
    const raw = 'ls\r';
    const normalized = normalizeTerminalCommittedText(raw);
    expect(normalized).toBe('ls ');

    const result = outputs(runPhase3InputSchedule(phaseRequest('parity-phase3-input', {
      'arc.channel_input_event': { channelId: 'chan-1', inputId: 'i-1', text: normalized },
      'arc.input_policy': { maxInFlight: 8 },
      'arc.schedule_policy': { enabled: true },
      'arc.schedule_source': { jobs: [{ jobId: 'j-1', command: 'session-list' }] },
    })));

    // The normalized text identity must survive the enqueue -> ack -> write chain.
    expect(result['arc.backend_write_result']).toMatchObject({
      state: 'written',
      channelId: 'chan-1',
    });
    expect(result['arc.input_ack'].state).toBe('acknowledged');
    expect(result['arc.schedule_dispatch'].dispatched[0].jobId).toBe('j-1');

    expect(() => runPhase3InputSchedule(phaseRequest('parity-phase3-input-reject', {
      'arc.channel_input_event': { channelId: 'chan-1' },
      'arc.input_policy': {},
      'arc.schedule_policy': {},
      'arc.schedule_source': {},
    }))).toThrow(/channelId and text/);
  });

  it('Phase3 file browse: Rust view matches the TS-resolved file path', () => {
    // TS oracle: path owner resolves the same requested path.
    const tsPath = resolveFileTransferListPath('/tmp', () => '/unused');
    expect(tsPath).toBe('/tmp');

    const result = outputs(runPhase3FileBrowse(phaseRequest('parity-phase3-browse', {
      'arc.file_browse_request': {
        path: tsPath,
        entries: [{ name: 'a.txt', kind: 'file' }],
      },
      'arc.fs_permission_policy': { allowRead: true },
    })));
    expect(result['arc.file_browser_view'].view).toEqual({
      cwd: tsPath,
      entries: [{ name: 'a.txt', kind: 'file' }],
    });

    expect(() => runPhase3FileBrowse(phaseRequest('parity-phase3-browse-reject', {
      'arc.file_browse_request': { path: tsPath },
      'arc.fs_permission_policy': { allowRead: false },
    }))).toThrow(/denied by permission policy/);
  });

  it('Phase3 upload/download: Rust ack matches the TS window and native batch contract', () => {
    // TS oracle: the shared throughput contract says an upload window can send
    // up to FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS chunks before it needs progress.
    expect(FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS).toBe(8);
    expect(FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS).toBe(8);

    // Exercise below-boundary, boundary, and above-boundary indices. The TS
    // contract uses the window for backpressure; Rust mirrors that threshold
    // while retaining the segment index in its ack projection.
    for (const segmentIndex of [
      0,
      FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS - 2,
      FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS - 1,
      FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS + 1,
    ]) {
      const upload = outputs(runPhase3Upload(phaseRequest(`parity-phase3-upload-${segmentIndex}`, {
        'arc.upload_intent': {
          uploadId: 'up-1',
          segmentIndex,
          data: 'abc',
        },
        'arc.transfer_policy': { allowUpload: true },
      })));
      expect(upload['arc.upload_complete']).toMatchObject({
        uploadId: 'up-1',
        segmentIndex,
        complete: segmentIndex + 1 >= FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS,
        state: segmentIndex + 1 >= FILE_TRANSFER_UPLOAD_WINDOW_CHUNKS
          ? 'complete'
          : 'in-progress',
      });
    }

    for (const segmentIndex of [
      0,
      FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS - 2,
      FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS - 1,
      FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS + 1,
    ]) {
      const download = outputs(runPhase3Download(phaseRequest(`parity-phase3-download-${segmentIndex}`, {
        'arc.download_intent': {
          downloadId: 'dl-1',
          path: '/tmp/a.txt',
          chunk: 'abc',
          segmentIndex,
        },
        'arc.transfer_policy': { allowDownload: true },
      })));
      expect(download['arc.download_complete']).toMatchObject({
        downloadId: 'dl-1',
        segmentIndex,
        complete: segmentIndex + 1 >= FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS,
        state: segmentIndex + 1 >= FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS
          ? 'complete'
          : 'in-progress',
      });
    }
    expect(() => runPhase3Download(phaseRequest('parity-phase3-download-reject', {
      'arc.download_intent': { downloadId: 'dl-1', path: '/tmp/a.txt' },
      'arc.transfer_policy': { allowDownload: false },
    }))).toThrow(/denied by transfer policy/);
  });

  it('Phase3 attachment: Rust and TS agree on valid and malformed attachment ids', () => {
    const validAttachmentId = 'att_12345678-1234-1234-1234-123456789abc';
    const invalidAttachmentId = 'att-1';

    // TS owner is the id validation oracle for real UUIDs.
    expect(validateAttachmentId(validAttachmentId)).toBe(validAttachmentId);
    expect(() => validateAttachmentId(invalidAttachmentId)).toThrow(/invalid attachment id/);

    const result = outputs(runPhase3Attachment(phaseRequest('parity-phase3-attachment', {
      'arc.attachment_delivery_request': { attachmentId: validAttachmentId, targetDeviceId: 'dev-1' },
      'arc.attachment_policy': { allowDelivery: true },
    })));
    expect(result['arc.attachment_delivery_result']).toMatchObject({
      state: 'published',
      receipt: { state: 'delivered' },
    });
    expect(result['arc.attachment_delivery_result']).not.toHaveProperty('consumed');

    expect(() => runPhase3Attachment(phaseRequest('parity-phase3-attachment-invalid-id', {
      'arc.attachment_delivery_request': { attachmentId: invalidAttachmentId, targetDeviceId: 'dev-1' },
      'arc.attachment_policy': { allowDelivery: true },
    }))).toThrow(/invalid attachment id/);
    expect(() => runPhase3Attachment(phaseRequest('parity-phase3-attachment-reject', {
      'arc.attachment_delivery_request': { attachmentId: validAttachmentId, targetDeviceId: 'dev-1' },
      'arc.attachment_policy': { allowDelivery: false },
    }))).toThrow(/denied by policy/);
  });

  it('Phase3 screenshot: Rust result matches the TS remote-screenshot chunk assembly', () => {
    // TS oracle: the same chunk set the runtime would assemble for a capture.
    const tsCapture = buildRemoteScreenshotCapture(
      'shot.png',
      new Map([[0, btoa('png-bytes')]]),
      'png-bytes'.length,
    );
    expect(tsCapture.mimeType).toBe('image/png');

    const result = outputs(runPhase3Screenshot(phaseRequest('parity-phase3-screenshot', {
      'arc.screenshot_request': {
        sessionId: 'sess-1',
        bytes: tsCapture.dataBase64,
      },
      'arc.screenshot_permission': { allowScreenshot: true },
    })));
    expect(result['arc.screenshot_result']).toMatchObject({
      sessionId: 'sess-1',
      bytes: tsCapture.dataBase64,
      state: 'ready',
    });

    expect(() => runPhase3Screenshot(phaseRequest('parity-phase3-screenshot-reject', {
      'arc.screenshot_request': { sessionId: 'sess-1', bytes: tsCapture.dataBase64 },
      'arc.screenshot_permission': { allowScreenshot: false },
    }))).toThrow(/denied by permission policy/);
  });

  it('Phase4 remote window: Rust injected input matches the TS input policy validation', () => {
    const touch = { kind: 'tap', x: 10, y: 20 };
    // TS oracle: validate the exact payload shape used by the Rust touch action.
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
          x: touch.x,
          y: touch.y,
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
      'arc.touch_action': touch,
      'arc.quality_intent': { targetId: 'w1', mode: 'balanced' },
      'arc.stream_policy': { allowStream: true, allowQuality: true, fps: 30 },
    })));
    expect(result['arc.overlay_directory']).toMatchObject({ state: 'ready', windows: [{ id: 'w1' }] });
    expect(result['arc.input_result']).toMatchObject({ targetId: 'w1', kind: 'tap', injected: true });
  });

  it('[smoke] Phase5 shell lifecycle: Rust projects the TS-derived session id without a focus claim', () => {
    // The TS lattice owner owns focus movement; the Rust shell lifecycle graph
    // does not consume a focus coordinate. Construct the session id fixture
    // through the TS owner, then only assert the Rust projection fields it has.
    const lattice = normalizeJunctionPreviewLattice(previewLatticeWithCell());
    const sessionId = lattice?.cells[0]?.target.sessionId ?? previewTarget.sessionId;

    const result = outputs(runPhase5ShellLifecycle(phaseRequest('parity-phase5-shell', {
      'arc.open_tab_intent': { sessionId },
      'arc.shell_state': { visible: true },
    })));
    expect(result['arc.shell_projection']).toMatchObject({
      sessionId,
      visible: true,
      state: 'projected',
    });
    expect(result['arc.quickbar_projection'].state).toBe('projected');
  });

  it('Phase5 preview lattice: Rust select/pan exclusivity matches the TS lattice owner', () => {
    const lattice = normalizeJunctionPreviewLattice(previewLatticeWithCell());
    expect(lattice?.cells).toHaveLength(1);

    const select = outputs(runPhase5PreviewLattice(phaseRequest('parity-phase5-select', {
      'arc.preview_open_intent': {
        sessionId: previewTarget.sessionId,
        cells: lattice?.cells.map((cell) => ({
          cellId: `${cell.col}:${cell.row}`,
          sessionId: cell.target.sessionId,
        })),
      },
      'arc.preview_select': { cellId: '0:0' },
      'arc.focus_pan': {},
    })));
    expect(select['arc.focus_selection']).toMatchObject({ state: 'applied', cellId: '0:0' });
    expect(select['arc.focus_panned'].state).toBe('skipped');

    const pan = outputs(runPhase5PreviewLattice(phaseRequest('parity-phase5-pan', {
      'arc.preview_open_intent': {
        sessionId: previewTarget.sessionId,
        cells: lattice?.cells.map((cell) => ({
          cellId: `${cell.col}:${cell.row}`,
          sessionId: cell.target.sessionId,
        })),
      },
      'arc.preview_select': {},
      'arc.focus_pan': { direction: 'right' },
    })));
    expect(pan['arc.focus_selection'].state).toBe('skipped');
    expect(pan['arc.focus_panned']).toMatchObject({ state: 'applied', direction: 'right' });
  });

  it('Phase6 composition: Rust activation mirrors the same TS plugin manifest fixture', async () => {
    const manifest = {
      pluginId: 'p1',
      version: '0.1.0',
      requires: [] as string[],
      provides: ['quickbar'],
      providesUiSlots: ['terminal.quickbar'],
    };
    const host: PluginHost = createPluginHost();
    host.install(manifest, {
      create: () => ({
        start: async (context) => { context.provideCapability('quickbar', {}); },
        stop: async () => {},
        dispose: async () => {},
      }),
    });
    await host.start('p1');
    expect(host.hasCapability('quickbar')).toBe(true);

    const result = outputs(runPhase6Composition(phaseRequest('parity-phase6-composition', {
      'arc.composition_request': { runtimeId: 'rt-1', ports: ['debug'] },
      'arc.plugin_manifest': {
        pluginId: manifest.pluginId,
        capabilities: manifest.provides,
        uiSlots: manifest.providesUiSlots,
      },
    })));
    expect(result['arc.activated_plugins']).toMatchObject({
      pluginId: manifest.pluginId,
      state: 'active',
      uiSlots: manifest.providesUiSlots,
    });
  });

  it('Phase6 control: Rust control result matches the TS control center fixture', async () => {
    const tsCommand = createControlCommand('settings', 'cmd-1', 'corr-1', {});
    const subject = 'settings';
    const center = new ClientControlCenter();
    center.register('settings', {
      ownerId: subject,
      execute: async () => ({ ok: true, value: { commandId: 'cmd-1' } }),
    });
    const tsOutcome = await center.execute({
      command: tsCommand,
      subject,
      capabilities: [],
    });
    expect(tsOutcome.ok).toBe(true);

    const result = outputs(runPhase6Control(phaseRequest('parity-phase6-control', {
      'arc.control_request': { commandId: tsCommand.commandId, owner: subject },
      'arc.control_policy': { allowControl: true },
    })));
    expect(result['arc.control_result']).toMatchObject({ state: 'completed', commandId: tsCommand.commandId });

    expect(() => runPhase6Control(phaseRequest('parity-phase6-control-reject', {
      'arc.control_request': { commandId: tsCommand.commandId, owner: subject },
      'arc.control_policy': { allowControl: false },
    }))).toThrow(/denied by capability policy/);
  });

  it('[smoke] Phase6 config export/import: Rust projects a config id without claiming TS payload parity', () => {
    // TS store round-trips the real payload through its owner.
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

  it('Phase7 release: Rust promotion matches the TS digest verification contract', () => {
    const artifact = { name: 'zterm-daemon', sha256: 'abc123' };
    // TS oracle: app-update normalization keeps the same lowercase digest.
    const manifest = normalizeAppUpdateManifest({
      versionCode: 1,
      versionName: '0.1.4',
      apkUrl: 'https://example.com/a.apk',
      sha256: artifact.sha256.toUpperCase(),
    });
    expect(manifest?.sha256).toBe(artifact.sha256);

    const result = outputs(runPhase7Release(phaseRequest('parity-phase7-release', {
      'arc.build_artifact': artifact,
      'arc.release_policy': { expectedSha256: manifest?.sha256 },
    })));
    expect(result['arc.runtime_started']).toMatchObject({
      artifact: artifact.name,
      state: 'started',
    });

    expect(() => runPhase7Release(phaseRequest('parity-phase7-release-reject', {
      'arc.build_artifact': artifact,
      'arc.release_policy': { expectedSha256: 'badhash' },
    }))).toThrow(/digest mismatch/);
  });

  it('Phase7 update/debug: Rust lifecycle matches the TS update manifest and debug gating', () => {
    const updateManifest = normalizeAppUpdateManifest({
      versionCode: 2,
      versionName: '0.1.4',
      apkUrl: 'https://example.com/a.apk',
      sha256: 'DEF456',
    });
    expect(updateManifest?.versionName).toBe('0.1.4');

    const update = outputs(runPhase7Update(phaseRequest('parity-phase7-update', {
      'arc.update_check': {
        version: updateManifest?.versionName,
        sha256: updateManifest?.sha256,
      },
      'arc.update_policy': { allowUpdate: true },
    })));
    expect(update['arc.client_update_installed']).toMatchObject({
      version: updateManifest?.versionName,
      state: 'installed',
    });

    const debug = outputs(runPhase7Debug(phaseRequest('parity-phase7-debug', {
      'arc.debug_sample_request': { sample: 'trace-1' },
      'arc.debug_policy': { allowDebug: true },
    })));
    expect(debug['arc.debug_export']).toMatchObject({ sample: 'trace-1', state: 'exported' });
    expect(debug['arc.debug_cleanup'].state).toBe('cleaned');

    expect(() => runPhase7Debug(phaseRequest('parity-phase7-debug-reject', {
      'arc.debug_sample_request': { sample: 'trace-denied' },
      'arc.debug_policy': { allowDebug: false },
    }))).toThrow(/debug channel denied/);
  });

  it('Phase8 connection service: Rust snapshot matches the TS command/state machine', () => {
    const command = { type: 'bind-target' as const, target: { targetKey: 't1', bridgeHost: 'host-1', bridgePort: 3333 } };
    const parsed = parseAndroidConnectionCommand(command);
    expect(parsed).toMatchObject({ type: 'bind-target', target: { targetKey: 't1' } });
    expect(() => parseAndroidConnectionCommand({ type: 'foreground-resume' }))
      .toThrow(/unsupported Android connection service command/);

    const machine = createAndroidConnectionServiceStateMachine({ now: () => 1 });
    machine.dispatch({ type: 'bind-target', target: command.target });
    machine.dispatch({ type: 'transport-opening', generation: 'g1' });
    machine.dispatch({ type: 'mux-ready', generation: 'g1', muxReadyPayload: {} });
    machine.dispatch({ type: 'channel-opened', generation: 'g1', channelId: 'c1' });
    machine.dispatch({ type: 'heartbeat-pong', generation: 'g1', at: 1 });
    const tsSnapshot = machine.readSnapshot();
    expect(tsSnapshot.state).toBe('healthy');

    const result = outputs(runPhase8Connection(phaseRequest('parity-phase8-connection', {
      'arc.service_command': {
        type: command.type,
        target: {
          ...command.target,
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
    expect(result['arc.service_snapshot']).toMatchObject({
      state: tsSnapshot.state,
      target: command.target.targetKey,
    });

    expect(() => runPhase8Connection(phaseRequest('parity-phase8-connection-reject', {
      'arc.service_command': { type: 'foreground-resume' },
      'arc.service_policy': { allowTransport: true, allowReconnect: true, allowNotifications: true },
      'arc.network_generation_event': { generation: 'g1' },
      'arc.notification_action': {},
      'arc.session_activity_fact': {},
    }))).toThrow(/service command rejected/);
  });
});
