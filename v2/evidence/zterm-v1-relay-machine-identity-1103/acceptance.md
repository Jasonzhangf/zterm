# V1 relay machine identity acceptance

Candidate: `layerfs:zterm/zterm-v1-relay-machine-identity-1103`

Validated implementation/test root:
`12397b3eb05fc37a7408fc8e543a79392adf98cb53e5b18094b894ce10b9c41759`

Base:
`3212912c739cbe98d95ee11c7286f16b4a4150f7f9c47ff2bf1206909d59cb5239`

Later commits only add evidence files. The task delivery reports the final branch head.

## Environment

- LayerFS sandbox 2, clean workspace mounted from the candidate.
- `pnpm install --frozen-lockfile` completed successfully.
- Node `v24.21.0`; pnpm `9.15.9`; Vitest `1.6.1`.
- Real relay ran against an isolated temporary data directory on loopback.
- No production daemon, production credentials, or production store was used.

## Public entry

All machine endpoints require a current bearer access token.

- `POST /api/auth/logout`
- `POST /api/machines/enroll/challenge` with `{ deviceId }`
- `POST /api/machines/enroll/verify` with
  `{ requestId, challenge, deviceToken, displayName? }`
- `POST /api/machines/possession/challenge` with `{ machineId }`
- `POST /api/machines/possession/verify` with
  `{ requestId, challenge, deviceToken }`
- `POST /api/machines/:machineId/revoke`

Enrollment and possession verification return the canonical
`{ machineId, ownerAccountId }`. The server generates `machineId`; device proof
material is stored only as SHA-256. Pending challenges are process-local and
expire after five minutes.

## Acceptance matrix

The raw black-box transcript is `blackbox-output.txt`.

- Logout current session: `200`.
- Authenticate with the same token after logout: `401`.
- Enrollment verify: `200`, with `ownerAccountId` equal to the registering
  account and a non-empty canonical `machineId`.
- Same-account enrollment replay: `200`, returning the same `machineId`.
- Second account replaying the same device proof: `409`,
  `machine_already_owned`.
- Possession with a wrong proof: `403`, `possession_invalid`.
- Possession with the registered proof: `200`, returning the same
  `machineId`.
- Foreign account revoking the machine: `403`, `machine_not_owned`.
- Owner revoking the machine: `200`, status `revoked`.
- Possession challenge after revocation: `403`, `machine_revoked`.
- Persisted state contains one machine record with status `revoked`; the
  plaintext device proof is absent.

## Gates

- Targeted test: 1 file, 3 tests passed. Raw: `test-targeted.txt`.
- Full traversal relay suite: 8 files, 70 tests passed. Raw: `test-full.txt`.
- `pnpm --dir android run type-check`: exit 0; source-JS pollution check clean.
  Raw: `type-check.txt`.
- Real two-account relay self-check:
  `node v2/evidence/zterm-v1-relay-machine-identity-1103/machine-identity-self-check.mjs`.
  Raw: `blackbox-output.txt`; terminal marker:
  `relay-machine-identity-blackbox-ok`.

## Boundary

The acceptance covers the V1 relay API and its persisted machine record. It
does not claim production deployment, global installation, daemon restart,
Android device delivery, or integration into the V2 accounts store.
