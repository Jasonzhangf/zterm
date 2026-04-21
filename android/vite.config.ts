import { existsSync, readFileSync } from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };
const appPackageName = 'com.zterm.android';
const buildMetaPath = resolve(__dirname, '.build-meta.json');
const buildMeta = existsSync(buildMetaPath)
  ? (JSON.parse(readFileSync(buildMetaPath, 'utf-8')) as { buildNumber?: number })
  : { buildNumber: 1000 };
const appBuildNumber = String(Math.max(1000, Math.floor(buildMeta.buildNumber || 1000))).padStart(4, '0');
const appDisplayVersion = `${pkg.version}.${appBuildNumber}`;

function computeVersionCode(version: string, buildNumber: number) {
  const semverParts = version.split('.').map((part) => {
    const matched = part.match(/^\d+/);
    return matched ? Number.parseInt(matched[0], 10) : 0;
  });
  while (semverParts.length < 3) {
    semverParts.push(0);
  }
  return (semverParts[0] * 100000000) + (semverParts[1] * 1000000) + (semverParts[2] * 10000) + buildNumber;
}

const appVersionCode = computeVersionCode(pkg.version, Number.parseInt(appBuildNumber, 10));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appDisplayVersion),
    __APP_BASE_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD_NUMBER__: JSON.stringify(appBuildNumber),
    __APP_VERSION_CODE__: JSON.stringify(String(appVersionCode)),
    __APP_PACKAGE_NAME__: JSON.stringify(appPackageName),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: true,
    port: 3000,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
