import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  ConfigStoreError,
  SharedConfigStore,
  type JsonObject,
} from '../../../packages/shared/src/node/shared-config';
import { readDaemonConfigProjection } from '../../../packages/shared/src/node/daemon-config-projection';

interface RelayInput {
  relayUrl: string;
  username: string;
  password: string;
  hostId: string;
  deviceId?: string;
  deviceName?: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requiredOption(args: string[], index: number, name: string) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function readStdin() {
  let content = '';
  for await (const chunk of process.stdin) {
    content += String(chunk);
  }
  return content.replace(/\r?\n$/, '');
}

async function parseRelayInput(args: string[]): Promise<RelayInput> {
  let relayUrl = '';
  let username = '';
  let hostId = '';
  let deviceId: string | undefined;
  let deviceName: string | undefined;
  let passwordStdin = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--relay-url':
        relayUrl = requiredOption(args, index, argument);
        index += 1;
        break;
      case '--username':
        username = requiredOption(args, index, argument);
        index += 1;
        break;
      case '--host-id':
        hostId = requiredOption(args, index, argument);
        index += 1;
        break;
      case '--device-id':
        deviceId = requiredOption(args, index, argument);
        index += 1;
        break;
      case '--device-name':
        deviceName = requiredOption(args, index, argument);
        index += 1;
        break;
      case '--password-stdin':
        passwordStdin = true;
        break;
      case '--password':
      case '--password-env':
        throw new Error('relay password must be supplied on stdin with --password-stdin');
      default:
        throw new Error(`unknown configure-relay option: ${argument}`);
    }
  }

  if (!passwordStdin) {
    throw new Error('configure-relay requires --password-stdin');
  }
  const password = await readStdin();
  if (!relayUrl || !username || !password || !hostId) {
    throw new Error('configure-relay requires --relay-url, --username, --password-stdin, and --host-id');
  }
  return { relayUrl, username, password, hostId, deviceId, deviceName };
}

function writeHumanProjection(projection: Awaited<ReturnType<typeof readDaemonConfigProjection>>) {
  process.stdout.write(`configPath=${projection.configPath}\n`);
  process.stdout.write(`configFound=${projection.configFound ? 'yes' : 'no'}\n`);
  for (const [name, value] of Object.entries({
    host: projection.host,
    port: projection.port,
    sessionName: projection.sessionName,
    cacheLines: projection.cacheLines,
  })) {
    process.stdout.write(
      `${name}=${String(value.value)} source=${value.sourceName}\n`,
    );
  }
  process.stdout.write(
    `auth=${projection.auth.configured ? 'configured' : 'not-configured'} source=${projection.auth.sourceName}\n`,
  );
  process.stdout.write('runtimeLoaded=unknown\n');
}

async function configureRelay(args: string[]) {
  const input = await parseRelayInput(args);
  const store = new SharedConfigStore();
  await store.update((latest) => {
    if (latest.mobile !== undefined && !isJsonObject(latest.mobile)) {
      throw new ConfigStoreError('invalid_config', 'mobile must be a JSON object', store.path);
    }
    const mobile: JsonObject = isJsonObject(latest.mobile) ? latest.mobile : {};
    latest.mobile = mobile;
    if (mobile.relay !== undefined && !isJsonObject(mobile.relay)) {
      throw new ConfigStoreError('invalid_config', 'mobile.relay must be a JSON object', store.path);
    }
    const relay: JsonObject = isJsonObject(mobile.relay) ? mobile.relay : {};
    const next: JsonObject = {
      ...relay,
      relayUrl: input.relayUrl,
      username: input.username,
      password: input.password,
      hostId: input.hostId,
      deviceId: input.deviceId || input.hostId,
      deviceName: input.deviceName || hostname(),
      platform: process.platform,
    };
    const changed = !isDeepStrictEqual(relay, next);
    mobile.relay = next;
    return { value: undefined, changed };
  }, undefined);
  process.stdout.write(
    `zterm relay configured: path=${store.path} relayUrl=${input.relayUrl} username=${input.username} hostId=${input.hostId} deviceName=${input.deviceName || hostname()} passwordSet=true\n`,
  );
}

export async function runTerminalConfigCommand(args: string[]) {
  const [command, ...rest] = args;
  if (command === 'daemon-config' && rest.length === 0) {
    writeHumanProjection(await readDaemonConfigProjection(new SharedConfigStore()));
    return;
  }
  if (command === 'daemon-config' && rest.length === 1 && rest[0] === '--shell') {
    const projection = await readDaemonConfigProjection(new SharedConfigStore());
    process.stdout.write(`HOST=${shellQuote(projection.host.value)}\n`);
    process.stdout.write(`PORT=${shellQuote(String(projection.port.value))}\n`);
    process.stdout.write(`SESSION_NAME=${shellQuote(projection.sessionName.value)}\n`);
    process.stdout.write(`AUTH_SOURCE=${shellQuote(projection.auth.source === 'file' ? 'config' : projection.auth.source)}\n`);
    process.stdout.write(`CONFIG_FOUND=${shellQuote(projection.configFound ? '1' : '0')}\n`);
    process.stdout.write(`CONFIG_DISPLAY_PATH=${shellQuote(projection.configPath)}\n`);
    return;
  }
  if (command === 'configure-relay') {
    await configureRelay(rest);
    return;
  }
  throw new Error('usage: terminal-config-command daemon-config [--shell]|configure-relay ...');
}

if (typeof require !== 'undefined' && require.main === module) {
  runTerminalConfigCommand(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof ConfigStoreError) {
      process.stderr.write(`zterm config ${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write(`zterm config failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
