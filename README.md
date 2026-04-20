# zterm

Application repo for the Android client and future Mac / Windows clients.

## Layout

- `android/` — current Android app
- `mac/` — future macOS client
- `win/` — future Windows client

## Dependencies

- Runtime npm packages come from the published `@jsonstudio/wtermmod-*` packages
- Runtime source changes still go to `../wterm`, but this app repo installs from npm
- install / build from repo root

## Android app

See `android/README.md` for build, install, and daemon commands.

## Mac app

See `mac/README.md` for the minimal executable package workflow.
