# Fix Design: Android Foreground Task Transition Flash

- Design ID: `FD-20260811-ANDROID-FOREGROUND-FLASH-01`
- Status: implemented, tested, live-verified on formal APK `0.1.3.2550`
- Base: `2564c474039e57ad2f5339ce554c78948853d11c`

## Confirmed Evidence

- The bright frames reproduce as a complete Freehand task surface, not an empty zterm React page.
- During lifecycle pause/resume, zterm `#root`, terminal body text, and persisted active page remain intact.
- Background zterm has no live Activity surface; Android must compose a task transition before the surface is reattached.
- The installed APK already contains the prior dark splash, dark WebView background, and `colorMode` changes, so that earlier explanation is incomplete.
- SurfaceFlinger exposes a zterm `starting_reveal` animation leash. Freehand can appear from a stored task snapshot even while its live Activity has no surface.
- Stable baseline on `0.1.3.2547`: after the light terminal is backgrounded, zterm owns a real task snapshot with `mIsRealSnapshot=true` and `mSnapshotColor=ffffffff`.

## Experiment Result

- H1 added `postSplashScreenTheme` and an opaque runtime `windowBackground` through a playground-only debug resource overlay.
- The intervention APK built and installed, but the restored baseline did not reproduce the original frame through the same entry.
- Because reverse intervention failed, H1 is not a proven root cause and must not be promoted.

## Confirmed Root Cause

- First divergence: Android captures the live light zterm terminal as a real task snapshot when `MainActivity` stops. On foreground task switch, Oplus/Android is allowed to compose that screenshot as the `SnapshotStartingWindow` before the live Activity surface is attached.
- Positive H2: playground calls `Activity.setRecentsScreenshotEnabled(false)` before `MainActivity` creation and supplies an opaque dark runtime theme background. The stored task entry changes to `mIsRealSnapshot=false` with black snapshot bundle `{mode=1,color=-16777216}`.
- Reverse H2: reinstalling canonical `0.1.3.2547` restores `mIsRealSnapshot=true` and `mSnapshotColor=ffffffff`.
- Android 36 source documents that disabling recents screenshots prevents Activity screenshots from representing a stopped Activity and permits the theme window background instead.

## Formal Fix

- Unique runtime owner: `native/android/app/src/main/java/com/zterm/android/MainActivity.java`.
- In `onCreate`, call `setRecentsScreenshotEnabled(false)` on API 33+ before `super.onCreate`.
- Unique background owner: `native/android/app/src/main/res/values/styles.xml`.
- Give `AppTheme.NoActionBar` an opaque `android:windowBackground` / `android:colorBackground`, and explicitly bind `postSplashScreenTheme` from launch theme to runtime theme.
- No `FLAG_SECURE`, JS lifecycle, transport, daemon, buffer, renderer, or duplicate snapshot policy.

## Test Design

- Positive static gate: `MainActivity` owns the API 33+ call before `super.onCreate`; runtime/launch themes own opaque background and post-splash binding.
- Negative static gate: no `FLAG_SECURE`; no JS/App/TerminalPage snapshot compensation.
- Runtime positive: stopped zterm task is `mIsRealSnapshot=false` with dark replacement; foreground logs do not attach `SnapshotStartingWindow`.
- Runtime reverse evidence: canonical pre-fix APK returns to a real white snapshot.

## Live Verification

- Formal APK: `0.1.3.2550` / `1100025500`, sha256 `75f04412514fc0ab0853a05f787bbe7060a3bee761479a8e5d36ecee0a6b8c11`.
- Local, Tailscale, and public Relay manifests all return version 2550 and the matching APK SHA; Relay GET/HEAD return HTTP 200.
- Installed on `100.104.163.65:5555`; three HOME -> foreground rounds on a real light terminal session each leave `mIsRealSnapshot=false`, `mSnapshotBundle={mode=1,color=-16777216}`, and `shouldAppSnapshot=false`.
- Immediate and settled foreground screenshots for all three rounds contain no white/light snapshot frame: `android/evidence/foreground-white-flash-20260811/formal-2550-run-*`.
- Formal APK still exposes the app-owned rename dialog and the QuickBar `编辑快捷按钮` entry: `zterm-2550-rename-dialog.png`, `zterm-2550-quickbar-editor.png`.

## Architecture Boundary

- Feature/module: `mainline_source.android` / `client.app_shell`.
- Resources: `resource.platform_terminal_surface -> resource.ui_projection`.
- Forbidden: terminal transport, daemon, sparse buffer, renderer, or JS lifecycle compensation.
- Registry update required before runtime edit: add `MainActivity.java`, `styles.xml`, and the native transition gate to `mainline_source.android.allowed_paths` and `client.app_shell.owned_paths`.
