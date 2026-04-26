import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface CaseSummary {
  caseName: string;
  ok: boolean;
}

function run(command: string, args: string[]) {
  execFileSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
}

function currentDateFolder() {
  return new Date().toISOString().slice(0, 10);
}

run('pnpm', ['exec', 'tsx', 'scripts/daemon-mirror-lab.ts', '--case=all', '--managed-daemon']);

const summaryPath = join(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder(), 'summary.json');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as CaseSummary[];

for (const item of summary) {
  if (!item.ok) {
    throw new Error(`lab case failed before replay: ${item.caseName}`);
  }
  run('pnpm', ['daemon:mirror:replay', `evidence/daemon-mirror/${currentDateFolder()}/${item.caseName}`]);
}

run('pnpm', ['exec', 'tsx', 'scripts/daemon-mirror-strict-audit.ts', `evidence/daemon-mirror/${currentDateFolder()}`]);

process.stdout.write(`[daemon-mirror-close-loop] all replay + strict audit cases passed: ${summary.map((item) => item.caseName).join(', ')}\n`);
