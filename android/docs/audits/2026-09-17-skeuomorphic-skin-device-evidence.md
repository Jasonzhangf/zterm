# Skeuomorphic Skin Device Evidence

Date: 2026-09-17

Scope: `client.ambient_controls` light/black skeuomorphic material states.

## Candidate

- Device: `emulator-5554`, `sdk_gphone64_arm64`
- Install: `adb -s emulator-5554 install -r <app-debug.apk>`
- Version: `0.1.3.3016`
- Version code: `1100030160`
- APK SHA-256: `17e4bbaabcc5683e1bfc9dd6b5b59a0373cb20f040ba5498d30a9a089ce0c1d7`
- APK size: `6876543` bytes
- Data preservation: `dataDir=/data/user/0/com.zterm.android`; `firstInstallTime=2026-09-08 06:36:23`

## Device State Matrix

Captured through WebView CDP against the installed APK:

| State | Black skin | Light skin |
| --- | --- | --- |
| Selected default | `bg=rgb(41,49,59)`, `color=rgb(124,240,173)`, active border/shadow | `bg=rgb(255,255,255)`, `color=rgb(11,107,69)`, active border/shadow |
| Selected hover | unchanged active bg/color/border/shadow | unchanged active bg/color/border/shadow |
| Selected pressed | pressed shadow `inset 0 2px 5px rgba(0,0,0,.78)` plus bottom highlight; `translateY(1px)` | pressed shadow `inset 0 2px 4px rgba(17,19,21,.20)` plus bottom highlight; `translateY(1px)` |
| Transparent flat row | hover and press keep `rgba(0,0,0,0)` background | hover and press keep `rgba(0,0,0,0)` background |
| Disabled control | `opacity=.42`, `cursor=not-allowed` | `opacity=.46`, `cursor=not-allowed` |
| Keyboard focus | `2px solid rgb(56,212,125)` | same focus token |

The press path is explicit state, not WebView `:active` timing: pointer down
sets `data-amb-pressed=true`, pointer up/cancel clears it, and CSS selects the
pressed material only for material controls. Flat controls stay outside that
state.

## Screenshot Evidence

Screenshots remain in the local ignored evidence store:

- `android/evidence/2026-09-17-skeuomorphic-skin/settings-black-3016.png`
  - SHA-256: `f73a47464ce5a930d9d17340059a6da13d72f7d9fd58f9aa34c29d5711601b6b`
- `android/evidence/2026-09-17-skeuomorphic-skin/settings-light-3016.png`
  - SHA-256: `c8c9db3f4c18dc3e36d5633d70eff08316b4bc4cde08928dce2a0e52809dc315`

## Automated Gates

- Targeted ambient render/truth tests: PASS
- `pnpm run test:terminal:shell-theme`: PASS, 228 tests
- `pnpm run type-check`: PASS
- `pnpm run build:android`: PASS
- OTA bundle verifier: PASS, including APK/manifest SHA, size, rollback, and
  next-normal replacement checks
- `git diff --check`: PASS

The public Relay update channel was not published for this candidate.
