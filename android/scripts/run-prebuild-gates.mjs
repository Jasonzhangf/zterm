import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PREBUILD_GATES = Object.freeze([
  'test:build-version',
  'test:traversal',
  'test:android-connection-service',
  'test:android-network-identity',
  'test:feature-registry',
  'test:shared-contract-ownership',
  'test:debug-observability',
  'test:runtime-architecture-v2',
  'test:plugin-host',
  'test:low-risk-plugin-ui',
  'test:debug-console-ui',
  'test:session-drawer-ui',
  'test:file-browser-ui',
  'test:settings-update-ui',
  'test:settings-connection-config',
  'test:remote-window-ui',
  'test:quickbar-ui',
  'test:terminal-shell-ui',
  'test:composition-root',
  'test:control-center',
  'test:daemon-control-center',
  'test:daemon-buffer-publisher',
  'test:daemon-session-catalog',
  'test:attachment-message-delivery',
  'test:file-transfer-message-route',
  'test:source-adapter-ownership',
  'test:mirror-writer-ownership',
  'test:input-normalizer',
  'test:reliable-input-ownership',
  'test:daemon-input-queue',
  'test:terminal-channel-mux',
  'test:session-input-runtime',
  'test:terminal:shell-theme',
  'test:file-transfer:throughput',
  'test:transport-network-lifecycle',
  'test:terminal:regression:core',
  'test:relay:account-directory',
  'test:workspace:panes',
]);

function runPnpmGate(name) {
  return spawnSync('pnpm', ['run', name], { stdio: 'inherit' });
}

export function runPrebuildGates({
  gates = PREBUILD_GATES,
  runGate = runPnpmGate,
  write = (line) => console.error(line),
} = {}) {
  const failures = [];

  for (const name of gates) {
    const result = runGate(name);
    const status = typeof result?.status === 'number' ? result.status : 1;
    if (status !== 0) failures.push({ name, status });
  }

  if (failures.length === 0) {
    write(`Prebuild gates passed (${gates.length})`);
    return 0;
  }

  write(`Prebuild gate failures (${failures.length}/${gates.length}):`);
  for (const { name, status } of failures) write(`- ${name}: exit ${status}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPrebuildGates();
}
