#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { createHerdrBackendRuntime, HerdrSessionLifecycleError } from '../src/server/herdr-backend-runtime';
interface Step { name: string; ok: boolean; detail: string; }
function listHerdrSessions(): string[] {
  const result = spawnSync('herdr', ['session', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error('herdr session list --json failed: ' + (result.stderr ?? ''));
  }
  const response = JSON.parse(result.stdout ?? '{}') as {
    sessions?: Array<{ name?: string; running?: boolean }>;
  };
  return (response.sessions ?? [])
    .filter((entry) => entry.running && typeof entry.name === 'string')
    .map((entry) => entry.name as string);
}
function pickMarkerSession(): string {
  const stamp = Date.now();
  return 'zterm-cordis-v2-herdr-lifecycle-' + stamp;
}
async function main() {
  const steps: Step[] = [];
  const sessionName = pickMarkerSession();
  const cwd = process.cwd();
  const beforeList = listHerdrSessions();
  steps.push({
    name: 'pre-create: target session not in running catalog',
    ok: !beforeList.includes(sessionName),
    detail: 'list-size=' + beforeList.length,
  });
  const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
  let created: ReturnType<typeof runtime.createSession>;
  try {
    created = runtime.createSession({ sessionName, cwd });
    steps.push({
      name: 'create: typed session created with exact identity',
      ok: created.sessionName === sessionName,
      detail: 'cols=' + created.cols + ' rows=' + created.rows,
    });
  } catch (error) {
    steps.push({
      name: 'create: typed session created with exact identity',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return report(steps, sessionName);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterCreate = listHerdrSessions();
  steps.push({
    name: 'post-create: exact session appears in running catalog',
    ok: afterCreate.includes(sessionName),
    detail: 'list-size=' + afterCreate.length,
  });
  try {
    runtime.closeSession(sessionName);
    steps.push({
      name: 'close: typed session closed without error',
      ok: true,
      detail: 'closed',
    });
  } catch (error) {
    steps.push({
      name: 'close: typed session closed without error',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  let doubleCloseRejected = false;
  try {
    runtime.closeSession(sessionName);
  } catch (error) {
    doubleCloseRejected = error instanceof HerdrSessionLifecycleError;
  }
  steps.push({
    name: 'post-close: second close rejected as typed lifecycle error',
    ok: doubleCloseRejected,
    detail: 'HerdrSessionLifecycleError thrown on double close',
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterClose = listHerdrSessions();
  steps.push({
    name: 'post-close: exact session no longer in running catalog',
    ok: !afterClose.includes(sessionName),
    detail: 'list-size=' + afterClose.length,
  });
  return report(steps, sessionName);
}
function report(steps: Step[], sessionName: string): never {
  process.stdout.write(JSON.stringify({ sessionName, steps }, null, 2) + '\n');
  const failed = steps.filter((step) => !step.ok);
  if (failed.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}
main().catch((error) => {
  process.stderr.write('crashed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(2);
});
