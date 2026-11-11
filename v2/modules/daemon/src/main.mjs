import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "./server.mjs";
import { loadStartupConfig } from "./startup-config.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function assertBindIsAllowed(host) {
  if (LOOPBACK_HOSTS.has(host)) {
    return;
  }
  if (process.env.ZTERM_V2_INSECURE_BIND === "1") {
    // Explicit opt-in for a trusted local tunnel terminates TLS in front.
    return;
  }
  throw new Error(
    `Refusing to bind the V2 daemon to non-loopback host ${host} without a supported secure transport.`,
  );
}

export async function startDaemon({
  port = 3334,
  host = "127.0.0.1",
  v1WsUrl,
  v1Token,
  v2Token,
  webuiDir,
  log,
  terminalPort,
  admission,
  clientInstanceId,
  workspaceAuth,
  organization,
  members,
  routing,
  memberHostObserver,
  terminalCatalog,
  authService,
  machineService,
  machineAuthorization,
  connectionManager,
  goals,
  tickets,
  board,
  resolveActor,
} = {}) {
  assertBindIsAllowed(host);

  const daemon = createDaemon({
    v1WsUrl,
    v1Token,
    v2Token,
    webuiDir,
    log: log || ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`)),
    terminalPort,
    admission,
    clientInstanceId,
    workspaceAuth,
    organization,
    members,
    routing,
    memberHostObserver,
    terminalCatalog,
    authService,
    machineService,
    machineAuthorization,
    connectionManager,
    goals,
    tickets,
    board,
    resolveActor,
  });

  await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(port, host, resolve);
  });

  return daemon;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const configPath = readArg(args, "--config") || process.env.ZTERM_V2_CONFIG || "";
  const assembled = configPath
    ? await loadStartupConfig(configPath)
    : null;
  const port = Number(
    readArg(args, "--port")
    || (assembled ? assembled.server.port : process.env.PORT)
    || 3334,
  );
  const host = readArg(args, "--host")
    || (assembled ? assembled.server.host : process.env.ZTERM_V2_HOST)
    || "127.0.0.1";
  const v1WsUrl = readArg(args, "--v1-ws-url") || process.env.ZTERM_V1_WS_URL || "";
  const v1Token = process.env.ZTERM_V1_AUTH_TOKEN || "";
  const v2Token = process.env.ZTERM_V2_AUTH_TOKEN || "";
  const webuiDir = readArg(args, "--webui-dir");

  const daemon = assembled
    ? await startDaemon({ port, host, ...assembled.daemonOptions })
    : await startDaemon({ port, host, v1WsUrl, v1Token, v2Token, webuiDir });
  const address = daemon.server.address();
  const effectiveV1Token = assembled ? assembled.daemonOptions.v1Token : v1Token;
  const effectiveV2Token = assembled ? assembled.daemonOptions.v2Token : v2Token;
  process.stdout.write(
    `${JSON.stringify({
      event: "listening",
      host: address.address,
      port: address.port,
      v1WsUrl: daemon.resolvedV1WsUrl,
      v2AuthRequired: Boolean(effectiveV2Token),
      v1AuthConfigured: Boolean(effectiveV1Token),
    })}\n`,
  );

  const close = () => {
    daemon.server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
