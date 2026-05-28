# zterm

Application repo for the Android client and future Mac / Windows clients.

## Layout

- `android/` — current Android app
- `mac/` — future macOS client
- `win/` — future Windows client

## Dependencies

- Runtime npm packages come from the published modified wterm packages: `@jsonstudio/wtermmod-core`, `@jsonstudio/wtermmod-dom`, and `@jsonstudio/wtermmod-react`
- Runtime source changes still go to `../wterm`, but this app repo installs from npm
- Android build runs `android/scripts/ensure-pnpm-install.sh` first, so missing workspace dependencies are installed automatically with `pnpm install --frozen-lockfile`
- Release builds also run `pnpm --dir android run deps:check-wterm-published` to ensure the required modified wterm versions exist on npm before producing the APK

## Android app

See `android/README.md` for build, install, and daemon commands.

## macOS daemon

The Android app connects to a macOS daemon that owns tmux access, file transfer, and remote screenshot capture.

```bash
npm install -g @jsonstudio/zterm-daemon
zterm-daemon install-service
zterm-daemon service-status
```

Default endpoint: `0.0.0.0:3333`. Optional config lives at `~/.wterm/config.json`.

Remote screenshot permission belongs to the installed native `zterm-daemon` binary. When macOS prompts for Screen Recording, approve `zterm-daemon`; Node.js and separate GUI helpers are not the permission owner.

Release packages are published on GitHub with:

- Android APK: `zterm-<version>.apk`
- update manifest: `latest.json`
- daemon standalone archive: `zterm-daemon-<version>-darwin-arm64.tar.gz`
- daemon npm tarball: `jsonstudio-zterm-daemon-<version>.tgz`

## Mac app

See `mac/README.md` for the minimal executable package workflow.
