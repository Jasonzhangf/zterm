import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const requiredDocs = [
  'docs/wiki/daemon.md',
  'docs/wiki/cli.md',
  'docs/wiki/mainline-source.md',
  'docs/wiki/modules.md',
  'docs/wiki/mainline-call-map.json',
  'docs/wiki/generated/daemon.html',
  'docs/wiki/generated/cli.html',
  'docs/wiki/generated/mainline-source.html',
  'docs/wiki/generated/modules.html',
] as const;

const requiredFunctionMapIds = [
  'daemon.runtime_entry',
  'daemon.cli_shell',
  'daemon.cli_node',
  'daemon.support',
  'mainline_source.android',
  'mainline_source.daemon',
  'mainline_source.cli',
] as const;

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function resolvePath(relativePath: string) {
  const androidPath = join(root, relativePath);
  if (existsSync(androidPath)) return androidPath;

  const repoPath = join(root, '..', relativePath);
  if (existsSync(repoPath)) return repoPath;

  return null;
}

describe('function wiki truth gate', () => {
  it('keeps worker wiki md files and generated mermaid html files present', () => {
    for (const relativePath of requiredDocs) {
      expect(existsSync(join(root, relativePath))).toBe(true);
    }
  });

  it('keeps generated mainline html in lockstep with every mermaid section', () => {
    const html = read('docs/wiki/generated/mainline-source.html');

    expect(html).toContain('<h2>Android Mainline</h2>');
    expect(html).toContain('<h2>Daemon Mainline</h2>');
    expect(html).toContain('<h2>CLI Mainline</h2>');
    expect(html).toContain('AppSdkPrebuildGate');
  });

  it('keeps daemon and cli function ids in the function map', () => {
    const functionMap = read('docs/function-map.md');
    for (const id of requiredFunctionMapIds) {
      expect(functionMap).toContain(id);
    }
    expect(functionMap).toContain('zterm-daemon.sh run');
    expect(functionMap).toContain('configure-relay');
    expect(functionMap).toContain('src/server/server.ts');
  });

  it('keeps architecture and workflow linked to worker wiki truth sources', () => {
    const architecture = read('docs/architecture.md');
    const workflow = read('docs/dev-workflow.md');

    for (const path of [
      'docs/wiki/daemon.md',
      'docs/wiki/cli.md',
      'docs/wiki/mainline-source.md',
      'docs/wiki/modules.md',
    ]) {
      expect(architecture).toContain(path);
      expect(workflow).toContain(path);
    }
    expect(architecture).toContain('scripts/build-function-wiki.mjs');
  });

  it('keeps the target-network probe Rust migration explicitly planned', () => {
    const architecture = read('docs/architecture.md');
    const plan = read('docs/goals/terminal-transport-multiplex-refactor-plan.md');

    expect(architecture).toContain(
      'docs/goals/terminal-transport-multiplex-refactor-plan.md#10-rust-migration-register',
    );
    expect(plan).toContain(
      '`migration_id`: `terminal.transport_lifecycle.target_network_probe.rust`',
    );
    expect(plan).toContain('`status`: `planned`');
    expect(plan).toContain(
      '`current_owner`: `android/src/contexts/session-context-target-network-probe-runtime.ts#createSessionTargetNetworkProbeRuntime`',
    );
    expect(plan).toContain(
      '`planned_target`: `crates/zterm-transport-core/src/target_network_probe.rs`',
    );
    expect(plan).toContain(
      '`native_snapshot_error_policy`: the typed `TargetNetworkProbeError04NativeSnapshot` must stay on the explicit error chain',
    );
    expect(plan).toContain(
      '`native_snapshot_error_current_owner`: `android/src/contexts/session-context-transport-orchestration-runtime.ts#reportTargetNetworkProbeErrorRuntime`',
    );
    expect(plan).toContain(
      '`native_snapshot_error_planned_rust_boundary`: `crates/zterm-transport-core/src/target_network_probe.rs` owns typed failure classification and error-chain emission',
    );
  });

  it('keeps terminal frame assembly Rust migration explicitly planned', () => {
    const decision = read('docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md');

    expect(decision).toContain(
      '`migration_id`: `terminal.buffer_render.frame_assembly.rust`',
    );
    expect(decision).toContain('`status`: `planned`');
    expect(decision).toContain(
      '`current_owner`: `android/src/lib/buffer-frame-assembly/session-buffer-frame-assembly.ts#assembleBufferSyncFrameChunk`',
    );
    expect(decision).toContain(
      '`planned_target`: `crates/zterm-terminal-core/src/buffer_frame_assembly.rs`',
    );
  });

  it('keeps wiki pages aligned with daemon and cli mainline source owners', () => {
    const daemon = read('docs/wiki/daemon.md');
    const cli = read('docs/wiki/cli.md');
    const mainline = read('docs/wiki/mainline-source.md');

    expect(daemon).toContain('feature_id`: `daemon.runtime_entry');
    expect(daemon).toContain('src/server/server.ts');
    expect(daemon).toContain('terminal-mirror-runtime.ts');
    expect(daemon).toContain('remote-screenshot-daemon.ts');

    expect(cli).toContain('feature_id`: `daemon.cli_shell');
    expect(cli).toContain('scripts/zterm-daemon.sh');
    expect(cli).toContain('install-service');
    expect(cli).toContain('configure-relay');

    expect(mainline).toContain('Android Mainline');
    expect(mainline).toContain('Daemon Mainline');
    expect(mainline).toContain('CLI Mainline');
  });

  it('keeps the machine-readable mainline call map aligned with wiki nodes and registry owners', () => {
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as {
      schema_version: number;
      lifecycles: Array<{
        lifecycle_id: string;
        title: string;
        entrypoint: string;
        owner_feature: string;
        canonical_docs: string[];
        verification_gates: string[];
        nodes: Array<{ id: string; label: string }>;
        edges: Array<{
          from: string;
          to: string;
          owner_feature: string;
          status: string;
          edge_id?: string;
          semantic_input?: string;
          resource_from?: string;
          resource_to?: string;
        }>;
      }>;
    };
    const mainline = read('docs/wiki/mainline-source.md');
    const registry = JSON.parse(read('docs/feature-registry.json')) as {
      features: Array<{ feature_id: string }>;
    };
    const featureIds = new Set(registry.features.map((feature) => feature.feature_id));

    expect(manifest.schema_version).toBe(1);
    expect(manifest.lifecycles.map((lifecycle) => lifecycle.lifecycle_id)).toEqual([
      'android_mainline',
      'android_preview',
      'daemon_mainline',
      'cli_mainline',
    ]);

    for (const lifecycle of manifest.lifecycles) {
      expect(mainline).toContain(lifecycle.title);
      expect(featureIds.has(lifecycle.owner_feature), lifecycle.owner_feature).toBe(true);

      const nodeIds = new Set(lifecycle.nodes.map((node) => node.id));
      expect(nodeIds.size, `${lifecycle.lifecycle_id}:duplicate-node-id`).toBe(lifecycle.nodes.length);
      expect(nodeIds.has(lifecycle.entrypoint), lifecycle.entrypoint).toBe(true);

      for (const docPath of lifecycle.canonical_docs) {
        expect(resolvePath(docPath), docPath).not.toBeNull();
      }

      for (const gatePath of lifecycle.verification_gates) {
        expect(resolvePath(gatePath), gatePath).not.toBeNull();
      }

      for (const node of lifecycle.nodes) {
        expect(mainline, node.id).toContain(node.id);
      }

      for (const edge of lifecycle.edges) {
        const expectedEdgeId = `${lifecycle.lifecycle_id}:${edge.from}->${edge.to}`;
        expect(nodeIds.has(edge.from), `${lifecycle.lifecycle_id}:${edge.from}`).toBe(true);
        expect(nodeIds.has(edge.to), `${lifecycle.lifecycle_id}:${edge.to}`).toBe(true);
        expect(featureIds.has(edge.owner_feature), edge.owner_feature).toBe(true);
        expect(['anchored', 'partial', 'active']).toContain(edge.status);
        expect(edge.status, edge.edge_id).not.toBe('binding pending');
        expect(edge.edge_id).toBe(expectedEdgeId);
      }
    }

    const manifestEdgeIds = new Set(
      manifest.lifecycles.flatMap((lifecycle) => lifecycle.edges.map((edge) => edge.edge_id)),
    );
    const networkSwitchTestDesign = read('docs/testing/session-transport-network-switch-test-design.md');
    const testDesignMainlineIds = Array.from(
      networkSwitchTestDesign.matchAll(/`((?:android|daemon|cli)_mainline:[^`]+)`/g),
      (match) => match[1],
    );
    expect(testDesignMainlineIds.length).toBeGreaterThan(0);
    for (const mainlineId of testDesignMainlineIds) {
      expect(manifestEdgeIds.has(mainlineId), mainlineId).toBe(true);
    }
    const bufferTestDesign = read('docs/testing/terminal-refresh-buffer-truth-test-design.md');
    const bufferMainlineIds = Array.from(
      bufferTestDesign.matchAll(/`((?:android|daemon|cli)_mainline:[^`]+)`/g),
      (match) => match[1],
    );
    expect(bufferMainlineIds.length).toBeGreaterThan(0);
    for (const mainlineId of bufferMainlineIds) {
      expect(manifestEdgeIds.has(mainlineId), mainlineId).toBe(true);
    }

    const androidMainline = manifest.lifecycles.find((lifecycle) => lifecycle.lifecycle_id === 'android_mainline');
    const platformSignalNode = androidMainline?.nodes.find((node) => node.id === 'PlatformNetworkSignal');
    const lifecycleSnapshotErrorNode = androidMainline?.nodes.find(
      (node) => node.id === 'LifecycleNativeSnapshotErrorProjector',
    );
    const openTabBindingNode = androidMainline?.nodes.find((node) => node.id === 'OpenTabNetworkBinding');
    const appBindingNode = androidMainline?.nodes.find((node) => node.id === 'AppNetworkBinding');
    const appSnapshotErrorNode = androidMainline?.nodes.find(
      (node) => node.id === 'AppNativeSnapshotErrorProjector',
    );
    const contextFacadeNode = androidMainline?.nodes.find((node) => node.id === 'SessionContextNetworkFacade');
    const providerBindingNode = androidMainline?.nodes.find((node) => node.id === 'SessionProviderNetworkBinding');
    const publicFacadeBindingNode = androidMainline?.nodes.find((node) => node.id === 'SessionPublicFacadeBinding');
    const providerCoreBindingNode = androidMainline?.nodes.find((node) => node.id === 'SessionProviderCoreBinding');
    const targetTransportAccessorsNode = androidMainline?.nodes.find((node) => node.id === 'TargetTransportAccessors');
    const targetTransportStoreEnumerationNode = androidMainline?.nodes.find((node) => node.id === 'TargetTransportStoreEnumeration');
    const targetProbeDispatchNode = androidMainline?.nodes.find((node) => node.id === 'TargetNetworkProbeDispatch');
    const targetProbeNode = androidMainline?.nodes.find((node) => node.id === 'TargetNetworkProbe');
    const terminalMuxPingBuilderNode = androidMainline?.nodes.find((node) => node.id === 'TerminalMuxPingBuilder');
    const targetMuxFrameLifecycleNode = androidMainline?.nodes.find((node) => node.id === 'TargetMuxFrameLifecycle');
    const targetNetworkActivityBindingNode = androidMainline?.nodes.find((node) => node.id === 'TargetNetworkActivityBinding');
    const targetFailureRouterNode = androidMainline?.nodes.find((node) => node.id === 'TargetFailureRouter');
    const nativeSnapshotErrorNode = androidMainline?.nodes.find(
      (node) => node.id === 'TargetNetworkProbeError04NativeSnapshot',
    );
    const daemonConnectionErrorNode = androidMainline?.nodes.find(
      (node) => node.id === 'DaemonConnectionErrorChain',
    );
    expect(platformSignalNode?.label).toBe(
      'src/hooks/useOpenTabLifecycleEffects.ts#useOpenTabLifecycleEffects (signal-only)',
    );
    expect(openTabBindingNode?.label).toBe('src/hooks/useOpenTabRuntime.ts#useOpenTabRuntime');
    expect(appBindingNode?.label).toBe('src/App.tsx#AppContent');
    expect(appSnapshotErrorNode?.label).toContain('src/App.tsx#AppContent');
    expect(lifecycleSnapshotErrorNode?.label).toBe(
      'src/hooks/useOpenTabLifecycleEffects.ts#refreshNetworkIdentityForForeground',
    );
    expect(targetProbeDispatchNode?.label).toBe(
      'src/contexts/session-context-transport-orchestration-runtime.ts#notifyTargetNetworkSignalRuntime',
    );
    expect(targetProbeNode?.label).toBe(
      'src/contexts/session-context-target-network-probe-runtime.ts#createSessionTargetNetworkProbeRuntime',
    );
    expect(terminalMuxPingBuilderNode?.label).toBe(
      'packages/shared/src/connection/protocol.ts#buildTerminalMuxPing',
    );
    expect(targetTransportAccessorsNode?.label).toBe(
      'src/contexts/session-context-transport-runtime.ts#createSessionContextTransportAccessors',
    );
    expect(targetTransportStoreEnumerationNode?.label).toBe(
      'src/lib/session-transport-runtime.ts#listTargetTransportRuntimes',
    );
    expect(targetMuxFrameLifecycleNode?.label).toBe(
      'src/contexts/session-context-transport-runtime.ts#bindTargetMuxTransportSocketLifecycleRuntime',
    );
    expect(targetNetworkActivityBindingNode?.label).toContain(
      'src/contexts/session-context-transport-orchestration-runtime.ts#createSessionTransportOrchestrationRuntime',
    );
    expect(contextFacadeNode?.label).toContain('src/contexts/SessionContext.tsx#SessionProvider');
    expect(providerBindingNode?.label).toBe(
      'src/contexts/session-context-provider-facade-assemblies.ts#useSessionProviderFacadeAssemblies',
    );
    expect(publicFacadeBindingNode?.label).toBe(
      'src/contexts/session-context-public-facade-runtime.ts#createSessionPublicFacadeRuntime',
    );
    expect(providerCoreBindingNode?.label).toBe(
      'src/contexts/session-context-provider-core-assemblies.ts#useSessionProviderCoreAssemblies',
    );
    expect(targetFailureRouterNode?.label).toBe(
      'src/contexts/session-context-transport-orchestration-runtime.ts#routeTargetSocketFailureRuntime',
    );
    expect(nativeSnapshotErrorNode?.label).toBe(
      'src/contexts/session-context-transport-orchestration-runtime.ts#reportTargetNetworkProbeErrorRuntime',
    );
    expect(daemonConnectionErrorNode?.label).toContain(
      'src/lib/client-daemon-connection.ts#createClientDaemonConnection',
    );
    expect(daemonConnectionErrorNode?.label).toContain('registered typed error consumer');
    expect(read('src/hooks/useOpenTabLifecycleEffects.ts')).toContain(
      'export function useOpenTabLifecycleEffects',
    );
    expect(read('src/hooks/useOpenTabRuntime.ts')).toContain('export function useOpenTabRuntime');
    expect(read('src/App.tsx')).toContain('export function AppContent');
    expect(read('src/contexts/session-context-transport-orchestration-runtime.ts')).toContain(
      'export function notifyTargetNetworkSignalRuntime',
    );
    expect(read('src/contexts/session-context-target-network-probe-runtime.ts')).toContain(
      'export function createSessionTargetNetworkProbeRuntime',
    );
    expect(read('src/contexts/session-context-transport-runtime.ts')).toContain(
      'export function createSessionContextTransportAccessors',
    );
    expect(read('src/lib/session-transport-runtime.ts')).toContain(
      'export function listTargetTransportRuntimes',
    );
    expect(read('src/contexts/session-context-transport-runtime.ts')).toContain(
      'options.recordTargetServerActivity?.(options.targetHeartbeatKey)',
    );
    expect(read('docs/function-map.md')).toContain(
      'packages/shared/src/connection/protocol.ts#TerminalMuxClientFrame`; `#TerminalMuxServerFrame`; `#buildTerminalMuxHello`; `#buildTerminalMuxPing`',
    );
    expect(read('../packages/shared/src/connection/protocol.ts')).toContain(
      'export function buildTerminalMuxPing',
    );
    expect(read('src/contexts/session-context-socket-runtime.ts')).toContain(
      'buildTerminalMuxPing(Date.now())',
    );
    expect(read('src/contexts/session-context-transport-orchestration-runtime.ts')).toContain(
      'buildTerminalMuxPing(sentAt)',
    );
    expect(read('src/contexts/SessionContext.tsx')).toContain('export function SessionProvider');
    expect(read('src/contexts/session-context-provider-facade-assemblies.ts')).toContain(
      'export function useSessionProviderFacadeAssemblies',
    );
    expect(read('src/contexts/session-context-public-facade-runtime.ts')).toContain(
      'export function createSessionPublicFacadeRuntime',
    );
    expect(read('src/contexts/session-context-provider-core-assemblies.ts')).toContain(
      'export function useSessionProviderCoreAssemblies',
    );
    const targetFailureRouterEdge = androidMainline?.edges.find((edge) => (
      edge.edge_id === 'android_mainline:TargetNetworkProbe->TargetFailureRouter'
    ));
    expect(targetFailureRouterEdge?.semantic_input).toContain('probe-send failure');
    expect(androidMainline?.edges.some((edge) => (
      edge.edge_id === 'android_mainline:TargetHeartbeat->TerminalMuxPingBuilder'
    ))).toBe(true);
    expect(androidMainline?.edges.some((edge) => (
      edge.edge_id === 'android_mainline:TargetNetworkSignalOrchestration->TerminalMuxPingBuilder'
    ))).toBe(true);
    for (const edgeId of [
      'android_mainline:NetworkIdentityRuntime->AppNativeSnapshotErrorProjector',
      'android_mainline:AppNativeSnapshotErrorProjector->AppNetworkBinding',
      'android_mainline:NetworkIdentityRuntime->LifecycleNativeSnapshotErrorProjector',
      'android_mainline:LifecycleNativeSnapshotErrorProjector->OpenTabNetworkBinding',
      'android_mainline:TargetNetworkSignalOrchestration->TargetNetworkProbeError04NativeSnapshot',
      'android_mainline:TargetNetworkProbeError04NativeSnapshot->DaemonConnectionErrorChain',
    ]) {
      expect(androidMainline?.edges.some((edge) => edge.edge_id === edgeId), edgeId).toBe(true);
    }
    for (const edgeId of [
      'android_mainline:TargetNetworkSignalOrchestration->TargetNetworkProbeError04NativeSnapshot',
      'android_mainline:TargetNetworkProbeError04NativeSnapshot->DaemonConnectionErrorChain',
    ]) {
      const edge = androidMainline?.edges.find((candidate) => candidate.edge_id === edgeId);
      expect(edge?.resource_from, edgeId).toBe('resource.platform_network_signal');
      expect(edge?.resource_to, edgeId).toBe('resource.platform_network_signal');
    }
  });

  it('keeps every function-map mainline edge in the machine-readable call map', () => {
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as {
      lifecycles: Array<{
        lifecycle_id: string;
        edges: Array<{ edge_id: string }>;
      }>;
    };
    const manifestEdgeIds = new Set(
      manifest.lifecycles.flatMap((lifecycle) => lifecycle.edges.map((edge) => edge.edge_id)),
    );
    const functionMap = read('docs/function-map.md');
    const functionMapMainlineIds = Array.from(
      functionMap.matchAll(/`((?:android|daemon|cli)_mainline:[^`]+)`/g),
      (match) => match[1],
    );

    expect(functionMapMainlineIds.length).toBeGreaterThan(0);
    for (const mainlineId of functionMapMainlineIds) {
      expect(manifestEdgeIds.has(mainlineId), mainlineId).toBe(true);
    }
  });

  it('keeps the relay directory route adjacent and rendered in the mermaid source', () => {
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as {
      lifecycles: Array<{
        lifecycle_id: string;
        edges: Array<{ from: string; to: string }>;
      }>;
    };
    const mainline = read('docs/wiki/mainline-source.md');
    const renderedEdges = new Set(
      Array.from(
        mainline.matchAll(/^\s*([A-Za-z0-9_]+)(?:\[[^\n]*\])?\s*-->\s*([A-Za-z0-9_]+)/gm),
        (match) => `${match[1]}->${match[2]}`,
      ),
    );
    const androidMainline = manifest.lifecycles.find((lifecycle) => (
      lifecycle.lifecycle_id === 'android_mainline'
    ));

    const relayDirectoryEdges = (androidMainline?.edges || []).filter((edge) => (
      edge.from === 'RelayDirectoryProjection'
      || edge.from === 'ClientControlPlaneTransport'
      || edge.from === 'TransportTargetResolver'
    ));
    const expectedRelayDirectoryEdges = [
      'RelayDirectoryProjection->ClientControlPlaneTransport',
      'ClientControlPlaneTransport->TransportTargetResolver',
      'TransportTargetResolver->TraversalSocketFactory',
    ];

    expect(relayDirectoryEdges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(
      expect.arrayContaining(expectedRelayDirectoryEdges),
    );
    expect(relayDirectoryEdges).not.toContainEqual({
      from: 'RelayDirectoryProjection',
      to: 'TraversalSocketFactory',
    });
    for (const renderedEdge of expectedRelayDirectoryEdges) {
      expect(renderedEdges.has(renderedEdge), `${renderedEdge} must be in mainline-source.md`).toBe(true);
    }
  });

  it('keeps generated html offline and sourced from mermaid diagrams', () => {
    for (const file of ['daemon', 'cli', 'mainline-source', 'modules']) {
      const md = read(`docs/wiki/${file}.md`);
      const html = read(`docs/wiki/generated/${file}.html`);
      expect(md).toContain('```mermaid');
      expect(html).toContain('<svg class="wiki-graph"');
      expect(html).toContain('<pre class="source">');
      expect(html).toContain('flowchart TD');
      expect(html).not.toContain('cdn.jsdelivr.net');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('https://');
    }
  });
});
