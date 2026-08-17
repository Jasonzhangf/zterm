# AppSDK Binary Gate Test Design

Date: 2026-08-17
Feature: `appsdk.binary_gate`
Module: `observability.appsdk_governance`
Resource: `resource.appsdk_compiler_identity`

## Goal

Prove that local prebuild, CI, and release verification resolve one AppSDK
executable from `PATH`, validate that executable against `.appsdk/project.json`
and `.appsdk/sdk.lock`, and execute record-graph verification through that same
absolute path. The project gate must not validate one compiler and then invoke a
different bare `appsdk` command.

## Boundary

- AppSDK remains the unique compiler and record-graph owner.
- `scripts/verify-appsdk-binary.mjs` owns only the project-side pinned compiler
  preflight and exact-binary invocation.
- The gate is a governance control resource. It cannot read or mutate terminal,
  daemon, mirror, transport, renderer, UI, Active, or Protected truth.
- Failure is explicit. There is no fallback binary, silent path cleanup, or
  second verify command.

## Lifecycle

```text
package prebuild / CI / release
-> package.json test:appsdk-verify
-> verifyPinnedAppSdkBinary
-> PATH-selected absolute executable
-> version + digest lock validation
-> same executable: appsdk verify <project>
```

Mainline bindings:

- `cli_mainline:AppSdkPrebuildGate->AppSdkPackageGate`
- `cli_mainline:AppSdkCiGate->AppSdkPackageGate`
- `cli_mainline:AppSdkReleaseGate->AppSdkPackageGate`
- `cli_mainline:AppSdkPackageGate->AppSdkBinaryPreflight`
- `cli_mainline:AppSdkBinaryPreflight->AppSdkRecordGraphVerify`

## White-Box Matrix

| case | expected result |
| --- | --- |
| Locked 0.1.3 binary | PASS; verify receives the exact project path. |
| Missing executable | `APPSDK_BINARY_MISSING`. |
| `sdk.lock.version` differs from project version | `APPSDK_LOCK_VERSION_MISMATCH`. |
| Binary version differs from project version | `APPSDK_BINARY_VERSION_MISMATCH`. |
| Lock digest or compiler digest differs from binary bytes | `APPSDK_BINARY_DIGEST_MISMATCH`. |
| Version probe exits non-zero | `APPSDK_VERSION_PROBE_FAILED`. |
| Empty `PATH` component selects a divergent current-directory binary | Reject the selected binary by digest; do not skip to a later binary. |
| Exact validated binary fails record verification | `APPSDK_VERIFY_FAILED`; do not invoke another executable. |

Owner test: `scripts/verify-appsdk-binary.test.mjs`.

## Module Black-Box Gates

- `src/lib/feature-registry-truth.test.ts` proves the feature, paths, test
  design, and human maps are registered.
- `src/lib/module-registry-truth.test.ts` proves the governance module owns the
  two project-side gate files and no product runtime resource.
- `src/lib/resource-registry-truth.test.ts` proves compiler identity is an
  active control resource owned by `appsdk.binary_gate`.
- `src/lib/function-wiki-truth.test.ts` and
  `src/lib/mainline-resource-call-map.test.ts` prove the package/CI/release
  callers reach record verification only through the preflight node.

## Project Black-Box Gates

```bash
node --test scripts/verify-appsdk-binary.test.mjs
pnpm run test:appsdk-verify
pnpm run test:feature-registry
pnpm run prebuild
pnpm run build
```

CI and Android release must both invoke `pnpm --dir android run
test:appsdk-verify`. A detached clean worktree must pass the same package gate
with the AppSDK 0.1.3 binary whose SHA-256 equals `sdk.lock.compiler_digest`.

## Positive And Negative Proof

- Positive: the fixture marker proves record verification ran through the
  validated executable and received the exact project root.
- Negative: missing/version/lock/digest/probe/empty-PATH/verify-failure cases
  all fail before a different executable can run.

## Known Gap

This gate proves compiler identity and record-graph invocation. It does not by
itself prove candidate source, artifact, lifecycle records, installation, or
runtime behavior; those remain separate AppSDK and project closeout gates.
