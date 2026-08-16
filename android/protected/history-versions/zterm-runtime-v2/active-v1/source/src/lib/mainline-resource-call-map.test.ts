import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

type ResourceRegistry = {
  resources: Array<{ resource_id: string; direct_relations: string[] }>;
  forbidden_direct_relations: Array<{ from: string; to: string }>;
};

type MainlineManifest = {
  lifecycles: Array<{
    lifecycle_id: string;
    nodes: Array<{
      id: string;
      label: string;
    }>;
    edges: Array<{
      edge_id: string;
      from: string;
      to: string;
      owner_feature: string;
      resource_from: string;
      resource_to: string;
      via_resources: string[];
      relation_status: 'direct' | 'via' | 'observer';
    }>;
  }>;
};

type EdgeRegistry = {
  edges: Array<{
    edge_id: string;
    owner_feature: string;
    request_chain: string[];
    response_chain: string[];
    error_chain: string[];
    mainline_call_ids: string[];
  }>;
};

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('mainline resource call map gate', () => {
  it('keeps every mainline edge resource-bound', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const resourceIds = new Set(registry.resources.map((resource) => resource.resource_id));

    for (const lifecycle of manifest.lifecycles) {
      for (const edge of lifecycle.edges) {
        expect(edge.resource_from, edge.edge_id).toMatch(/^resource\./);
        expect(edge.resource_to, edge.edge_id).toMatch(/^resource\./);
        expect(resourceIds.has(edge.resource_from), edge.edge_id).toBe(true);
        expect(resourceIds.has(edge.resource_to), edge.edge_id).toBe(true);
        expect(['direct', 'via', 'observer']).toContain(edge.relation_status);
        expect(edge.relation_status, edge.edge_id).not.toBe('binding pending');
        expect(Array.isArray(edge.via_resources), edge.edge_id).toBe(true);
        for (const via of edge.via_resources) {
          expect(resourceIds.has(via), `${edge.edge_id}:${via}`).toBe(true);
        }
      }
    }
  });

  it('rejects forbidden direct resource edges in the call map', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const forbidden = new Set(registry.forbidden_direct_relations.map((relation) => `${relation.from}->${relation.to}`));

    for (const lifecycle of manifest.lifecycles) {
      for (const edge of lifecycle.edges) {
        if (edge.relation_status === 'direct') {
          expect(forbidden.has(`${edge.resource_from}->${edge.resource_to}`), edge.edge_id).toBe(false);
        }
      }
    }
  });

  it('requires every direct edge to exist in the resource registry', () => {
    const registry = JSON.parse(read('docs/resource-registry.json')) as ResourceRegistry;
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const directEdges = new Set<string>();

    for (const resource of registry.resources) {
      for (const target of resource.direct_relations) {
        directEdges.add(`${resource.resource_id}->${target}`);
      }
    }

    for (const lifecycle of manifest.lifecycles) {
      for (const edge of lifecycle.edges) {
        if (edge.relation_status === 'direct') {
          expect(directEdges.has(`${edge.resource_from}->${edge.resource_to}`), edge.edge_id).toBe(true);
        }
        if (edge.relation_status === 'via') {
          expect(edge.via_resources.length, edge.edge_id).toBeGreaterThan(0);
        }
      }
    }
  });

  it('locks file-transfer throughput nodes to numbered adjacent call edges', () => {
    const manifest = JSON.parse(read('docs/wiki/mainline-call-map.json')) as MainlineManifest;
    const requiredNodeIds = [
      'ClientFileTransferUploadOut01SheetIntent',
      'ClientFileTransferUploadOut02BoundedWindow',
      'ClientFileTransferUploadOut03ChunkDispatch',
      'ClientFileTransferUploadOut04MuxSend',
      'DaemonFileTransferUploadIn01MessageDispatch',
      'DaemonFileTransferUploadIn02RuntimeFacade',
      'DaemonFileTransferUploadIn03CumulativeAckOwner',
      'DaemonFileTransferUploadEndIn04ExactCompletionOwner',
      'DaemonFileTransferUploadProgressOut01CumulativeAck',
      'DaemonFileTransferUploadSuccessOut01Complete',
      'DaemonFileTransferTransportOut01Send',
      'ClientFileTransferUploadAckIn01SocketDispatch',
      'ClientFileTransferUploadAckIn02SessionProjection',
      'ClientFileTransferDownloadIn01SocketDispatch',
      'ClientFileTransferDownloadIn02SessionProjection',
      'ClientFileTransferDownloadIn03SheetPersistence',
      'ClientFileTransferDownloadIn04NativeWriteBatch',
      'ClientFileTransferDownloadIn05NativeWriteDispatch',
      'ClientFileTransferDownloadIn06NativeStore',
      'ClientFileTransferDownloadPersistOut01BytesWritten',
      'ClientFileTransferDownloadPersistOut02VerifiedStat',
      'ClientFileTransferUploadErrorOut01WireFrameLimit',
      'ClientFileTransferUploadErrorIn01ProgressTimeout',
      'ClientFileTransferDownloadErrorIn01StaleRequest',
      'ClientFileTransferDownloadErrorIn02NativeWriteFailure',
      'ClientFileTransferDownloadErrorIn03SizeMismatch',
      'DaemonFileTransferMessageIn01Owner',
      'DaemonFileTransferUploadErrorOut01ChunkRejected',
      'DaemonFileTransferUploadErrorOut02CompletionRejected',
    ];
    const requiredEdges = [
      'android_mainline:ClientFileTransferUploadOut01SheetIntent->ClientFileTransferUploadOut02BoundedWindow',
      'android_mainline:ClientFileTransferUploadOut02BoundedWindow->ClientFileTransferUploadOut03ChunkDispatch',
      'android_mainline:ClientFileTransferUploadOut03ChunkDispatch->ClientFileTransferUploadOut04MuxSend',
      'daemon_mainline:Message->DaemonFileTransferMessageIn01Owner',
      'daemon_mainline:DaemonFileTransferMessageIn01Owner->DaemonFileTransferUploadIn02RuntimeFacade',
      'daemon_mainline:DaemonFileTransferUploadIn01MessageDispatch->DaemonFileTransferUploadIn02RuntimeFacade',
      'daemon_mainline:DaemonFileTransferUploadIn02RuntimeFacade->DaemonFileTransferUploadIn03CumulativeAckOwner',
      'daemon_mainline:DaemonFileTransferUploadIn02RuntimeFacade->DaemonFileTransferUploadEndIn04ExactCompletionOwner',
      'daemon_mainline:DaemonFileTransferUploadIn03CumulativeAckOwner->DaemonFileTransferUploadProgressOut01CumulativeAck',
      'daemon_mainline:DaemonFileTransferUploadProgressOut01CumulativeAck->DaemonFileTransferTransportOut01Send',
      'daemon_mainline:DaemonFileTransferUploadEndIn04ExactCompletionOwner->DaemonFileTransferUploadSuccessOut01Complete',
      'daemon_mainline:DaemonFileTransferUploadSuccessOut01Complete->DaemonFileTransferTransportOut01Send',
      'daemon_mainline:DaemonFileTransferTransportOut01Send->TransportSend',
      'android_mainline:ClientFileTransferUploadAckIn01SocketDispatch->ClientFileTransferUploadAckIn02SessionProjection',
      'android_mainline:ClientFileTransferDownloadIn01SocketDispatch->ClientFileTransferDownloadIn02SessionProjection',
      'android_mainline:ClientFileTransferDownloadIn02SessionProjection->ClientFileTransferDownloadIn03SheetPersistence',
      'android_mainline:ClientFileTransferDownloadIn03SheetPersistence->ClientFileTransferDownloadIn04NativeWriteBatch',
      'android_mainline:ClientFileTransferDownloadIn04NativeWriteBatch->ClientFileTransferDownloadIn05NativeWriteDispatch',
      'android_mainline:ClientFileTransferDownloadIn05NativeWriteDispatch->ClientFileTransferDownloadIn06NativeStore',
      'android_mainline:ClientFileTransferDownloadIn06NativeStore->ClientFileTransferDownloadPersistOut01BytesWritten',
      'android_mainline:ClientFileTransferDownloadPersistOut01BytesWritten->ClientFileTransferDownloadPersistOut02VerifiedStat',
      'daemon_mainline:DaemonFileTransferUploadIn03CumulativeAckOwner->DaemonFileTransferUploadErrorOut01ChunkRejected',
      'daemon_mainline:DaemonFileTransferUploadErrorOut01ChunkRejected->DaemonFileTransferTransportOut01Send',
      'daemon_mainline:DaemonFileTransferUploadEndIn04ExactCompletionOwner->DaemonFileTransferUploadErrorOut02CompletionRejected',
      'daemon_mainline:DaemonFileTransferUploadErrorOut02CompletionRejected->DaemonFileTransferTransportOut01Send',
    ];
    const nodeIds = new Set(manifest.lifecycles.flatMap((lifecycle) => lifecycle.nodes.map((node) => node.id)));
    const edgeIds = new Set(manifest.lifecycles.flatMap((lifecycle) => lifecycle.edges.map((edge) => edge.edge_id)));

    for (const nodeId of requiredNodeIds) {
      expect(nodeId).toMatch(/^(Client|Daemon)FileTransfer[A-Za-z]+(?:In|Out)\d{2}[A-Za-z]+$/);
      expect(nodeIds.has(nodeId), nodeId).toBe(true);
    }
    for (const edgeId of requiredEdges) {
      expect(edgeIds.has(edgeId), edgeId).toBe(true);
    }

    const daemonFileTransferNodeIds = new Set(
      Array.from(nodeIds).filter((nodeId) => nodeId.startsWith('DaemonFileTransfer')),
    );
    const daemonFileTransferEdges = manifest.lifecycles
      .flatMap((lifecycle) => lifecycle.edges)
      .filter((edge) => daemonFileTransferNodeIds.has(edge.from) || daemonFileTransferNodeIds.has(edge.to));
    expect(
      daemonFileTransferEdges.map((edge) => edge.edge_id).sort(),
      'daemon file-transfer induced subgraph must contain only the registered adjacent edges',
    ).toEqual(requiredEdges.filter((edgeId) => edgeId.startsWith('daemon_mainline:')).sort());
    for (const edge of daemonFileTransferEdges) {
      expect(edge.owner_feature, edge.edge_id).toBe('daemon.file_transfer');
    }

    const daemonOutputNodes = [
      'DaemonFileTransferUploadProgressOut01CumulativeAck',
      'DaemonFileTransferUploadSuccessOut01Complete',
      'DaemonFileTransferUploadErrorOut01ChunkRejected',
      'DaemonFileTransferUploadErrorOut02CompletionRejected',
    ];
    for (const outputNode of daemonOutputNodes) {
      expect(
        daemonFileTransferEdges.filter((edge) => edge.from === outputNode).map((edge) => edge.to),
        `${outputNode}:single convergence owner`,
      ).toEqual(['DaemonFileTransferTransportOut01Send']);
    }

    const edgeRegistry = JSON.parse(read('docs/edge-registry.json')) as EdgeRegistry;
    const fileTransferEdges = edgeRegistry.edges.filter(
      (edge) => edge.owner_feature === 'daemon.file_transfer',
    );
    for (const edge of fileTransferEdges) {
      expect(edge.request_chain, `${edge.edge_id}:request_chain`).toHaveLength(2);
      const requestCallSuffix = `${edge.request_chain[0]}->${edge.request_chain[1]}`;
      const requestCallId = edge.mainline_call_ids.find((callId) => callId.endsWith(requestCallSuffix));
      expect(requestCallId, `${edge.edge_id}:${requestCallSuffix}`).toBeDefined();
      expect(edgeIds.has(requestCallId!), `${edge.edge_id}:${requestCallId}`).toBe(true);
      for (const nodeId of [
        ...edge.request_chain,
        ...edge.response_chain,
        ...edge.error_chain,
      ]) {
        expect(nodeIds.has(nodeId), nodeId).toBe(true);
      }
    }
  });
});
