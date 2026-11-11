import { readFile } from "node:fs/promises";

import { TypedError } from "../../errors/src/public/index.mjs";
import {
  AuthService,
  MachineService,
  V1RelayAdapter,
  createAccountsAuthorizationPort,
  createFileAccountAuthorizationStore,
  createMemberIdentityService,
  createWorkspaceAuthorization,
} from "../../accounts/src/public/contracts.ts";
import { createOrganizationService, createOrganizationStore } from "../../organization/src/public/index.mjs";
import { createRoutingService } from "../../routing/src/public/index.mjs";
import { createBindingStore, createMembersService, resolveBindingTarget } from "../../members/src/public/index.mjs";
import { createConnectionManager, V1TraversalTransport } from "../../connections/src/public/index.mjs";
import { createTmuxHostProbe } from "../../host-adapters/src/public/index.mjs";
import { TerminalPort } from "../../terminal/src/public/index.mjs";
import { createFileGoalStore, createGoalService } from "../../goals/src/public/index.mjs";
import { createTicketComposition } from "../../tickets/src/public/contracts.ts";
import {
  GoalsPublicAdapter,
  ManagerBoardReader,
  OrganizationPublicAdapter,
} from "../../board/src/public/contracts.ts";
import { resolveV1WsUrl } from "./server.mjs";
import { createConnectionMachineTerminal } from "./machine-terminal-consumer.mjs";

const MODULE = "daemon";

function startupError(code, message, details = null, cause = null) {
  return new TypedError({
    code,
    owningModule: MODULE,
    operationId: "startup-config",
    cause,
    message,
    details,
  });
}

function fail(code, message, details = null) {
  throw startupError(code, message, details);
}

function requireSection(config, name) {
  const section = config && typeof config === "object" ? config[name] : undefined;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `startup config requires section "${name}".`, { section: name });
  }
  return section;
}

function requireText(section, field, sectionName) {
  const value = section[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(
      "DAEMON_STARTUP_CONFIG_INVALID",
      `startup config requires ${sectionName}.${field} to be a non-empty string.`,
      { section: sectionName, field },
    );
  }
  return value.trim();
}

function optionalText(section, field) {
  return typeof section[field] === "string" ? section[field].trim() : "";
}

function optionalPort(section, field, fallback) {
  const value = section[field];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  // Port 0 asks the OS for an ephemeral port; any other value must be a real
  // TCP port. This is the bind port, not a traversal bridge port.
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    fail(
      "DAEMON_STARTUP_CONFIG_INVALID",
      `startup config requires ${field} to be an integer between 0 and 65535 when provided.`,
      { field },
    );
  }
  return value;
}

function optionalSection(config, name) {
  const section = config && typeof config === "object" ? config[name] : undefined;
  if (section === undefined || section === null) {
    return null;
  }
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `startup config section "${name}" must be an object when provided.`, { section: name });
  }
  return section;
}

function requireArray(section, field, sectionName) {
  const value = section[field];
  if (!Array.isArray(value)) {
    fail(
      "DAEMON_STARTUP_CONFIG_INVALID",
      `startup config requires ${sectionName}.${field} to be an array.`,
      { section: sectionName, field },
    );
  }
  return value;
}

function requirePositiveInteger(section, field, sectionName) {
  const value = section[field];
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(
      "DAEMON_STARTUP_CONFIG_INVALID",
      `startup config requires ${sectionName}.${field} to be a positive integer.`,
      { section: sectionName, field },
    );
  }
  return value;
}

function requireProviderStatus(value, sectionName, field) {
  if (value === undefined || value === null) return "active";
  if (value !== "active" && value !== "disabled" && value !== "credential-invalid") {
    fail(
      "DAEMON_STARTUP_CONFIG_INVALID",
      `startup config requires ${sectionName}.${field} to be active, disabled, or credential-invalid.`,
      { section: sectionName, field, value },
    );
  }
  return value;
}

function createEnvironmentCredentialProvider(providerInstances) {
  return {
    async getCredential(providerInstanceId) {
      const instance = providerInstances.find((candidate) => candidate.providerInstanceId === providerInstanceId);
      const credentialRef = instance?.credentialRef;
      if (!credentialRef) {
        throw Object.assign(new Error(`provider instance ${providerInstanceId} has no credential reference`), {
          code: "PROVIDER_UNAVAILABLE",
          owningModule: "tickets",
        });
      }
      const token = process.env[credentialRef];
      if (typeof token !== "string" || token.length === 0) {
        throw Object.assign(new Error(`environment credential ${credentialRef} is not set`), {
          code: "PROVIDER_UNAUTHORIZED",
          owningModule: "tickets",
        });
      }
      return { token };
    },
  };
}

function createUnresolvedActorResolver() {
  return {
    async resolve() {
      throw Object.assign(new Error("verified account-to-member actor mapping is not configured"), {
        code: "TICKET_SCOPE_FORBIDDEN",
        owningModule: "tickets",
      });
    },
  };
}

function createMemberActorResolver({ authService, accountStore, organization }) {
  if (
    !authService
    || !accountStore
    || !organization
    || typeof organization.getMember !== "function"
  ) {
    return createUnresolvedActorResolver();
  }
  const memberIdentity = createMemberIdentityService({
    authService,
    store: accountStore,
    members: {
      getMember(memberId) {
        return organization.getMember(memberId);
      },
    },
  });
  return {
    async resolve({ token, workspaceId }) {
      return memberIdentity.resolveWorkspaceActor({ token, workspaceId });
    },
  };
}

function createBoardAccountsReader({ actorResolver }) {
  return {
    async verifySession(token, workspaceId) {
      return actorResolver.resolve({ token, workspaceId });
    },
  };
}

function validateMachineRoute(route, machineId) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `machine route "${machineId}" must be an object.`, { machineId });
  }
  if (route.machineId !== undefined && route.machineId !== machineId) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `machine route "${machineId}" has a mismatched machineId.`, {
      machineId,
      routeMachineId: route.machineId,
    });
  }
  const daemonHostId = requireText(route, "daemonHostId", `connections.machineRoutes.${machineId}`);
  const capabilities = route.capabilities;
  if (!capabilities || typeof capabilities !== "object") {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `machine route "${machineId}" requires capabilities.`, { machineId });
  }
  const target = route.target;
  if (!target || typeof target !== "object") {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `machine route "${machineId}" requires a traversal target.`, { machineId });
  }
  if (typeof target.bridgeHost !== "string" || target.bridgeHost.trim().length === 0) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `machine route "${machineId}" target requires bridgeHost.`, { machineId });
  }
  if (!Number.isInteger(target.bridgePort) || target.bridgePort <= 0) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `machine route "${machineId}" target requires a positive bridgePort.`, { machineId });
  }
  if (typeof target.daemonHostId !== "string" || target.daemonHostId !== daemonHostId) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `machine route "${machineId}" target daemonHostId must equal route daemonHostId.`, {
      machineId,
      routeDaemonHostId: daemonHostId,
      targetDaemonHostId: target.daemonHostId ?? null,
    });
  }
  const settings = route.settings && typeof route.settings === "object" ? route.settings : {};
  return {
    machineId,
    daemonHostId,
    capabilities,
    target,
    settings,
  };
}

function createStaticMachineRouteSource(routesConfig) {
  const routes = new Map();
  if (!routesConfig || typeof routesConfig !== "object" || Array.isArray(routesConfig)) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", "startup config requires connections.machineRoutes to be an object.");
  }
  for (const [machineId, route] of Object.entries(routesConfig)) {
    routes.set(machineId, Object.freeze(validateMachineRoute(route, machineId)));
  }
  return {
    async get(machineId) {
      const route = routes.get(machineId);
      return route ? { ...route, capabilities: { ...route.capabilities }, target: { ...route.target }, settings: { ...route.settings } } : undefined;
    },
  };
}

/**
 * Production startup/config assembly for the V2 daemon.
 *
 * The daemon owns composition only. Every module truth stays with its public
 * owner: accounts verifies sessions and machine authorization, the
 * organization owns the workspace tree, members owns runtime bindings and the
 * binding target resolver, connections owns links/channels/catalog, and the
 * host adapter owns tmux host observation. A missing config section fails
 * closed before the HTTP server starts; there is no token-only fallback for
 * the admitted terminal routes.
 */
/**
 * @param {object} options
 * @param {() => object} [options.createTransport] test-only transport factory.
 *   Production defaults to the connections-owned V1TraversalTransport public
 *   export; tests may inject a stub without reaching the real network.
 */
export function assembleDaemonConfig(
  config,
  {
    log = () => {},
    createTransport = () => new V1TraversalTransport(),
    actorResolver = null,
    credentialProvider = null,
    vikunjaClient = null,
    createMuxClient,
    createTerminalPort,
  } = {},
) {
  const server = requireSection(config, "server");
  const auth = requireSection(config, "auth");
  const terminalConfig = requireSection(config, "terminal");
  const accounts = requireSection(config, "accounts");
  const organizationConfig = requireSection(config, "organization");
  const membersConfig = requireSection(config, "members");
  const hostAdapter = requireSection(config, "hostAdapter");
  const connections = requireSection(config, "connections");
  const workTrackingConfig = optionalSection(config, "workTracking");
  if (typeof createTransport !== "function") {
    fail(
      "DAEMON_STARTUP_CONFIG_INVALID",
      "daemon startup requires createTransport to be a function when provided.",
      { section: "connections", field: "createTransport" },
    );
  }

  const host = optionalText(server, "host") || "127.0.0.1";
  const port = optionalPort(server, "port", 3334);
  const webuiDir = optionalText(server, "webuiDir");
  const v2Token = requireText(auth, "v2Token", "auth");

  const v1WsUrl = requireText(terminalConfig, "v1WsUrl", "terminal");
  const v1Token = optionalText(terminalConfig, "v1Token");

  const relayBaseUrl = requireText(accounts, "relayBaseUrl", "accounts");
  const authorizationStoreFile = requireText(accounts, "authorizationStoreFile", "accounts");
  const machineAuthorizationToken = requireText(accounts, "machineAuthorizationToken", "accounts");

  const organizationStoreFile = requireText(organizationConfig, "storeFile", "organization");
  const bindingStoreFile = requireText(membersConfig, "bindingStoreFile", "members");

  const hostBackend = requireText(hostAdapter, "backend", "hostAdapter");
  const hostSocketName = requireText(hostAdapter, "socketName", "hostAdapter");
  const hostMachineId = requireText(hostAdapter, "machineId", "hostAdapter");

  const relay = new V1RelayAdapter({ baseUrl: relayBaseUrl });
  const authService = new AuthService({ authority: relay });
  const accountStore = createFileAccountAuthorizationStore(authorizationStoreFile);
  const workspaceAuth = createWorkspaceAuthorization({ authService, store: accountStore });
  const machineService = new MachineService({
    machineReg: relay,
    verifySession: (token) => authService.verifySession(token),
  });
  const authorizationPort = createAccountsAuthorizationPort({
    token: machineAuthorizationToken,
    authService,
    machineService,
    routes: createStaticMachineRouteSource(connections.machineRoutes),
  });

  const organization = createOrganizationService({
    store: createOrganizationStore(organizationStoreFile),
    auth: workspaceAuth,
  });
  const hostProbe = createTmuxHostProbe({
    backend: hostBackend,
    socketName: hostSocketName,
    machineId: hostMachineId,
  });
  const members = createMembersService({
    store: createBindingStore(bindingStoreFile),
    auth: workspaceAuth,
    organization,
    hostProbe,
  });
  const routing = createRoutingService({ organization, members, auth: workspaceAuth });
  const connectionManager = createConnectionManager({
    authorizationPort,
    transport: createTransport(),
  });
  const terminalPort = new TerminalPort({
    wsUrl: resolveV1WsUrl(v1WsUrl, v1Token),
    log,
  });
  const machineTerminal = createConnectionMachineTerminal({
    connectionManager,
    authorizationPort,
    localMachineId: hostMachineId,
    terminal: terminalPort,
    log,
    ...(createMuxClient !== undefined ? { createMuxClient } : {}),
    ...(createTerminalPort !== undefined ? { createTerminalPort } : {}),
  });

  const memberHostObserver = {
    async observe({ runtime, binding }) {
      try {
        return await hostProbe.probe({
          memberId: runtime.memberId,
          machineId: runtime.machineId,
          sessionId: binding.sessionId,
          anchor: binding.anchor,
        });
      } catch (error) {
        return {
          available: false,
          machineId: runtime.machineId ?? null,
          sessionId: binding.sessionId ?? null,
          anchor: binding.anchor ?? null,
          observedAt: new Date().toISOString(),
          reason: error && error.code ? error.code : "host_observation_failed",
        };
      }
    },
  };

  let goals = null;
  let tickets = null;
  let board = null;
  if (workTrackingConfig) {
    const goalsStoreFile = requireText(workTrackingConfig, "goalsStoreFile", "workTracking");
    const ticketsStoreFile = requireText(workTrackingConfig, "ticketsStoreFile", "workTracking");
    const rawProviderInstances = requireArray(workTrackingConfig, "providerInstances", "workTracking");
    const rawWorkspaceProviders = requireArray(workTrackingConfig, "workspaceProviders", "workTracking");
    const providerInstances = rawProviderInstances.map((instance) => ({
      providerInstanceId: requireText(instance, "providerInstanceId", "workTracking.providerInstances"),
      baseUrl: requireText(instance, "baseUrl", "workTracking.providerInstances"),
      credentialRef: requireText(instance, "credentialRef", "workTracking.providerInstances"),
      status: requireProviderStatus(instance.status, "workTracking.providerInstances", "status"),
    }));
    const providerIds = new Set(providerInstances.map((instance) => instance.providerInstanceId));
    const workspaceProviders = rawWorkspaceProviders.map((provider) => {
      const providerInstanceId = requireText(provider, "providerInstanceId", "workTracking.workspaceProviders");
      if (!providerIds.has(providerInstanceId)) {
        fail(
          "DAEMON_STARTUP_CONFIG_INVALID",
          "startup config workTracking.workspaceProviders references an unknown provider instance.",
          { section: "workTracking.workspaceProviders", providerInstanceId },
        );
      }
      return {
        workspaceId: requireText(provider, "workspaceId", "workTracking.workspaceProviders"),
        providerInstanceId,
        externalProjectId: requirePositiveInteger(provider, "externalProjectId", "workTracking.workspaceProviders"),
        authority: requireText(provider, "authority", "workTracking.workspaceProviders"),
      };
    });
    const resolvedActorResolver = actorResolver || createMemberActorResolver({
      authService,
      accountStore,
      organization,
    });
    const resolvedCredentialProvider = credentialProvider || createEnvironmentCredentialProvider(providerInstances);

    // The goals service accepts the tickets facade before tickets is assigned;
    // any goal deletion call reaches this reader only after startup completes.
    let ticketsFacade = null;
    const ticketReferences = {
      hasTicketReference(...args) {
        if (!ticketsFacade) {
          return Promise.reject(new Error("tickets facade is not ready"));
        }
        return ticketsFacade.hasGoalReference(...args);
      },
    };
    goals = createGoalService({
      store: createFileGoalStore(goalsStoreFile),
      auth: workspaceAuth,
      organization,
      references: ticketReferences,
    });
    tickets = createTicketComposition({
      storeFile: ticketsStoreFile,
      providerInstances,
      workspaceProviders,
      credentialProvider: resolvedCredentialProvider,
      ...(vikunjaClient ? { vikunjaClient } : {}),
      accountReader: {
        async readAuthorization(token) {
          return workspaceAuth.verify(token);
        },
      },
      organization,
      goals,
      actorResolver: resolvedActorResolver,
    });
    ticketsFacade = tickets;
    board = new ManagerBoardReader({
      accounts: createBoardAccountsReader({ actorResolver: resolvedActorResolver }),
      organization: new OrganizationPublicAdapter(organization),
      goals: new GoalsPublicAdapter(goals),
      tickets: {
        listForGoalTopFive(actor, workspaceId, goalId) {
          return tickets.listForGoalTopFive(actor, workspaceId, goalId);
        },
      },
      members: {
        async observeMember({ actor, workspaceId, memberId }) {
          return {
            subjectRef: { kind: "member", workspaceId, memberId },
            source: "status-provider-unconfigured",
            observedAt: new Date().toISOString(),
            freshness: "unknown",
            value: "unknown",
          };
        },
      },
    });
  }

  return {
    server: { host, port, webuiDir },
    daemonOptions: {
      v1WsUrl,
      v1Token,
      v2Token,
      terminalPort,
      ...(webuiDir ? { webuiDir } : {}),
      log,
      workspaceAuth,
      organization,
      members,
      routing,
      goals,
      tickets,
      board,
      memberHostObserver,
      machineService,
      machineAuthorization: authorizationPort,
      connectionManager,
      admission: {
        auth: workspaceAuth,
        members,
        routing,
        machineTerminal,
        resolveBindingTarget,
      },
    },
  };
}

export async function loadStartupConfig(filePath, options = {}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", "startup config requires a file path.");
  }
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `startup config file could not be read: ${filePath}.`, { filePath }, error);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    fail("DAEMON_STARTUP_CONFIG_INVALID", `startup config file is not valid JSON: ${filePath}.`, { filePath }, error);
  }
  return assembleDaemonConfig(config, options);
}
