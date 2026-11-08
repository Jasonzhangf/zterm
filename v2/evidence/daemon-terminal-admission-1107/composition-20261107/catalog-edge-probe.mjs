import { createConnectionManager } from "../../../modules/connections/src/index.ts";
import { createConnectionMachineTerminal } from "../../../modules/daemon/src/machine-terminal-consumer.mjs";

const machineId = "machine-composition-probe";
const daemonHostId = "daemon-composition-probe";
let channelOpens = 0;
let channelSends = 0;

const manager = createConnectionManager({
  authorizationPort: {
    authorizeMachine: async () => ({
      machineId,
      daemonHostId,
      accountId: "account-composition-probe",
      authorizationId: "authorization-composition-probe",
      capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
      target: {
        bridgeHost: "127.0.0.1",
        bridgePort: 1,
        daemonHostId,
        relayHostId: daemonHostId,
        relayEndpointCandidates: [],
        transportMode: "websocket",
      },
      settings: { transportMode: "websocket" },
    }),
  },
  transport: {
    open: async () => ({
      path: "direct",
      transportKind: "ws",
      peerIdentity: daemonHostId,
      peerIdentityVerified: true,
      peerChannelKinds: ["terminal"],
      bufferedBytes: 0,
      openChannel: async () => {
        channelOpens += 1;
        return {};
      },
      sendChannel: () => {
        channelSends += 1;
      },
      closeChannel: () => {},
      close: () => {},
      onChannelMessage: () => () => {},
      onClose: () => {},
      onChannelClosed: () => () => {},
      onChannelCloseFailure: () => () => {},
      retryLateOpenClose: () => {},
    }),
  },
});

const result = {
  connectionManager: {
    create: typeof createConnectionManager,
    listSessions: typeof manager.listSessions,
  },
  channelOpensBeforeCatalogFailure: channelOpens,
  channelSendsBeforeCatalogFailure: channelSends,
};

try {
  await createConnectionMachineTerminal({ connectionManager: manager })
    .forMachine({ machineId, memberId: "member-composition-probe", bindingGeneration: 1 });
  result.outcome = "unexpected-success";
} catch (error) {
  result.outcome = "typed-failure";
  result.error = {
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    cause: error?.cause ?? null,
  };
}

result.channelOpensAfterCatalogFailure = channelOpens;
result.channelSendsAfterCatalogFailure = channelSends;
console.log(JSON.stringify(result, null, 2));
