import { resolve } from 'node:path';

import { redactEvidenceDirectory } from './platform-smoke-helper.mjs';

const directory = process.argv[2];
if (!directory) {
  process.stderr.write(
    'Usage: node packages/cli/scripts/platform-smoke-redact.mjs <evidence-dir>\n',
  );
  process.exitCode = 2;
} else {
  const summary = redactEvidenceDirectory(resolve(directory));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
