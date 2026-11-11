import {
  createConnectionManager as createBaseConnectionManager,
  type AccountsAuthorizationPort,
  type AuthorizedMachineLink,
  type ConnectionManager,
  type ConnectionManagerOptions,
  type LinkRef,
} from "../../src/index";

const TEST_CALLER_TOKEN = "test-caller-token";

type LegacyAccountsAuthorizationPort = Omit<
  AccountsAuthorizationPort,
  "authorizeCallerMachine"
> & {
  authorizeCallerMachine?: AccountsAuthorizationPort["authorizeCallerMachine"];
};

type LegacyConnectionManagerOptions = Omit<
  ConnectionManagerOptions,
  "authorizationPort"
> & {
  authorizationPort: LegacyAccountsAuthorizationPort;
};

type CallerBoundConnectionManager = ConnectionManager & {
  connect(
    machineId: string,
    callerTokenOrAuthorization?: string | AuthorizedMachineLink,
    verifiedAuthorization?: AuthorizedMachineLink,
  ): Promise<LinkRef>;
};

function callerBoundPort(
  port: LegacyAccountsAuthorizationPort,
): AccountsAuthorizationPort {
  if (typeof port.authorizeCallerMachine === "function") {
    return port as AccountsAuthorizationPort;
  }
  return {
    ...port,
    authorizeCallerMachine: (machineId) => port.authorizeMachine(machineId),
  } as AccountsAuthorizationPort;
}

/**
 * Test adapter for contracts written before the caller-token parameter.
 * New tests use the real public factory and pass the caller token explicitly.
 */
export function createConnectionManager(
  options: LegacyConnectionManagerOptions,
): CallerBoundConnectionManager {
  const manager = createBaseConnectionManager({
    ...options,
    authorizationPort: callerBoundPort(options.authorizationPort),
  });
  const connect = manager.connect.bind(manager);
  manager.connect = (
    machineId: string,
    callerTokenOrAuthorization?: string | AuthorizedMachineLink,
    verifiedAuthorization?: AuthorizedMachineLink,
  ) => {
    if (
      callerTokenOrAuthorization
      && typeof callerTokenOrAuthorization === "object"
    ) {
      return connect(machineId, TEST_CALLER_TOKEN, callerTokenOrAuthorization);
    }
    return connect(
      machineId,
      typeof callerTokenOrAuthorization === "string"
        ? callerTokenOrAuthorization
        : TEST_CALLER_TOKEN,
      verifiedAuthorization,
    );
  };
  return manager as CallerBoundConnectionManager;
}
