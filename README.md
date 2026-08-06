# zterm

zterm is the app-level repository for the Android, Mac, and Windows clients plus the zterm daemon release surface.

The terminal runtime source is not vendored here. Runtime changes belong in the upstream runtime repository and are consumed here through published `@jsonstudio/wtermmod-*` npm packages.

## Repository Layout

```text
zterm/
├── android/              # Current Android client and daemon/release owner
├── mac/                  # Mac desktop client
├── win/                  # Windows desktop client
├── packages/shared/      # zterm-owned shared contracts, projection helpers, and UI primitives
├── assets/               # Shared product assets used by app clients
├── scripts/              # Repository-level maintenance gates
├── .agents/              # Project-local agent skills
├── .github/              # CI and release workflows
├── AGENTS.md             # Project execution rules
├── package.json          # Root workspace commands
├── pnpm-workspace.yaml   # Active app workspace only
└── README.md
```

Legacy runtime and demo source trees are intentionally not part of this app repo. The root layout gate blocks those trees from being reintroduced.

## Development

Install dependencies:

```bash
pnpm install
```

Common commands:

```bash
pnpm run test:repo-layout
pnpm --dir android run type-check
pnpm --dir android run test:feature-registry
pnpm --dir mac run type-check
pnpm --dir win run type-check
```

Android app and daemon work starts in `android/`. The canonical Android workflow is documented in `android/README.md`, `android/docs/architecture.md`, and `android/docs/dev-workflow.md`.

Mac and Windows desktop work starts in `mac/` and `win/` respectively. Shared app contracts and reusable UI/runtime projection helpers live in `packages/shared/`.

## Runtime Dependencies

- Android client: Capacitor + React + `@jsonstudio/wtermmod-react`
- Desktop clients: Electron + React + `@jsonstudio/wtermmod-react`
- Daemon release: Node.js + tmux + node-pty
- Shared contracts: `@zterm/shared`

Do not copy runtime source into this repository. If runtime behavior needs to change, update the runtime repository, publish the package, then consume the new package version here.

## macOS Daemon

Install from release artifact:

```bash
curl -fsSL https://github.com/Jasonzhangf/zterm/releases/latest/download/zterm-daemon-<version>-darwin-arm64.tar.gz | tar xz
cd zterm-daemon-<version>-darwin-arm64
./bin/install-global.sh
```

Or install from npm:

```bash
npm install -g @jsonstudio/zterm-daemon
```

Common daemon commands:

```bash
zterm-daemon install-service
zterm-daemon service-status
zterm-daemon restart
zterm-daemon status
```

Default daemon config path:

```text
~/.zterm/config.json
```

## Android APK Updates

APK update bundles are built from `android/` and served by the daemon update channel:

```text
http://<daemon-host>:3333/updates/latest.json
http://<daemon-host>:3333/updates/zterm-<version>.apk
```

Release and update verification commands live in `android/package.json`; use `pnpm --dir android run build:android` for the standard debug APK/update bundle path.

## Source Of Truth

- `AGENTS.md`: repository execution rules
- `android/docs/architecture.md`: module and resource boundaries
- `android/docs/feature-registry.json`: feature ownership and gates
- `android/docs/module-registry.json`: module ownership
- `android/docs/resource-registry.json`: resource ownership
- `android/docs/wiki/mainline-call-map.json`: mainline call edges
