import { CLI_PACKAGE_NAME } from './release.js';

declare const __ZTERM_CLI_VERSION__: string;

if (process.argv.includes('--version')) {
  console.log(`zterm ${__ZTERM_CLI_VERSION__}`);
} else {
  console.log(`${CLI_PACKAGE_NAME} fixture entry`);
}
