import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dagpipeDir = join(androidRoot, 'docs', 'dagpipe');
const graphFiles = readdirSync(dagpipeDir)
  .filter((name) => name.endsWith('.graph.json'))
  .sort()
  .map((name) => join(dagpipeDir, name));

const expectedCore = [
  'daemon-mirror-publish.graph.json',
  'daemon-control-dispatch.graph.json',
  'android-connection-lifecycle.graph.json',
  'android-buffer-management.graph.json',
  'android-buffer-render.graph.json',
  'android-input-dispatch.graph.json',
];
const missingCore = expectedCore.filter(
  (name) => !graphFiles.some((fullPath) => fullPath.endsWith(`/${name}`)),
);

function runDagpipe(args) {
  return spawnSync('dagpipe', args, { cwd: androidRoot, stdio: 'inherit' });
}

let failed = false;
for (const graphFile of graphFiles) {
  for (const command of [
    ['graph', 'validate', graphFile],
    ['graph', 'inspect', graphFile],
  ]) {
    const result = runDagpipe(command);
    if (result.status !== 0) failed = true;
  }
}

if (graphFiles.length === 0 || missingCore.length > 0 || failed) {
  if (graphFiles.length === 0) {
    console.error(`DAGpipe Phase0 gate: no graph files found in ${dagpipeDir}`);
  }
  if (missingCore.length > 0) {
    console.error(`DAGpipe Phase0 gate: missing expected core graph(s): ${missingCore.join(', ')}`);
  }
  process.exitCode = 1;
} else {
  console.log(`DAGpipe Phase0 gate: validated ${graphFiles.length} graph file(s)`);
}
