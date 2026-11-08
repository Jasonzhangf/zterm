import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "./server.mjs";

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
  clientInstanceId,
} = {}) {
  assertBindIsAllowed(host);

  const daemon = createDaemon({
    v1WsUrl,
    v1Token,
    v2Token,
    webuiDir,
    log: log || ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`)),
    terminalPort,
    clientInstanceId,
  });

  await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(port, host, resolve);
  });

  return daemon;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const port = Number(readArg(args, "--port") || process.env.PORT || 3334);
  const host = readArg(args, "--host") || process.env.ZTERM_V2_HOST || "127.0.0.1";
  const v1WsUrl = readArg(args, "--v1-ws-url") || process.env.ZTERM_V1_WS_URL || "";
  const v1Token = process.env.ZTERM_V1_AUTH_TOKEN || "";
  const v2Token = process.env.ZTERM_V2_AUTH_TOKEN || "";
  const webuiDir = readArg(args, "--webui-dir");

  const daemon = await startDaemon({ port, host, v1WsUrl, v1Token, v2Token, webuiDir });
  const address = daemon.server.address();
  process.stdout.write(
    `${JSON.stringify({
      event: "listening",
      host: address.address,
      port: address.port,
      v1WsUrl: daemon.resolvedV1WsUrl,
      v2AuthRequired: Boolean(v2Token),
      v1AuthConfigured: Boolean(v1Token),
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
