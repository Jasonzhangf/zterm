import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(moduleRoot, '../../..')
const localNodeModules = join(moduleRoot, 'node_modules')
const pnpmStoreRoot = join(repositoryRoot, 'node_modules', '.pnpm')
const packageManifest = JSON.parse(readFileSync(join(moduleRoot, 'package.json'), 'utf8'))

function readPackageVersion(packageDirectory) {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
  return manifest.version
}

function resolvePackageDirectory(packageName, expectedVersion) {
  const localDirectory = join(localNodeModules, packageName)
  if (existsSync(localDirectory) && readPackageVersion(localDirectory) === expectedVersion) {
    return localDirectory
  }

  if (existsSync(pnpmStoreRoot)) {
    const storePrefix = `${packageName.replace('/', '+')}@`
    const storeDirectories = readdirSync(pnpmStoreRoot)
      .filter((entry) => entry.startsWith(storePrefix))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))

    for (const storeDirectory of storeDirectories.reverse()) {
      const candidate = join(pnpmStoreRoot, storeDirectory, 'node_modules', packageName)
      if (existsSync(candidate) && readPackageVersion(candidate) === expectedVersion) {
        return candidate
      }
    }
  }

  throw new Error(
    `Unable to resolve ${packageName}@${expectedVersion}. Run "pnpm --dir ${moduleRoot} install --ignore-workspace" or install the root workspace dependencies.`,
  )
}

const esbuildDirectory = resolvePackageDirectory('esbuild', packageManifest.devDependencies.esbuild)
const wtermDomDirectory = resolvePackageDirectory(
  '@jsonstudio/wtermmod-dom',
  packageManifest.dependencies['@jsonstudio/wtermmod-dom'],
)

const esbuildRequire = createRequire(join(esbuildDirectory, 'package.json'))
const { build } = esbuildRequire('esbuild')
const entryPoint = join(moduleRoot, 'src', 'clients', 'pane-terminal-wterm.entry.js')
const outfile = join(moduleRoot, 'src', 'clients', 'pane-terminal.bundle.js')
const nodePaths = [dirname(dirname(wtermDomDirectory))]

if (!statSync(entryPoint).isFile()) {
  throw new Error(`Missing pane terminal entry: ${entryPoint}`)
}

await build({
  absWorkingDir: moduleRoot,
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  loader: {
    '.css': 'text',
  },
  nodePaths,
  logLevel: 'info',
})
