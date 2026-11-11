# connections-v1-traversal-public-export-20261108 result

Status: COMPLETE for the scoped candidate. Integration black-box remains with
the parent task owner.

## Goal

Expose `V1TraversalTransport` through the connections public module entry. This
lets daemon startup/config import the transport across the public boundary
without using the private `src/index.ts`.

## Change

- `v2/modules/connections/src/public/index.mjs`
  - Added `export { V1TraversalTransport } from "../adapters/v1-traversal.ts";`

No transport implementation, transport semantics, daemon, startup-config,
accounts, members, routing, or host-adapter code changed.

## Gates

- `node --check v2/modules/connections/src/public/index.mjs`: exit 0.
- `node --experimental-strip-types -e "import(...public/index.mjs)..."`: exit 0.
  - Public exports remained exactly `ConnectionError`,
    `V1TraversalTransport`, `createConnectionManager`, and
    `resolveAuthorizedTerminalDirectory`.
  - The imported `V1TraversalTransport` constructed successfully.
- `git diff -- v2/modules/connections/src/public/index.mjs`: exit 0.

Raw command output is in `node-check.txt`, `public-import.txt`, and
`git-diff.txt`.

## Limits

This result is a worktree candidate only. It does not include a real daemon or
startup-config black-box run. Leo still needs to merge the candidate into the
startup-config worktree and run the real daemon gate. Mia remains the terminal
admission reviewer, and Jenny owns integration.
