# Multi-pane Refresh Plan

## Goal
Reduce multi-pane terminal latency by removing same-frequency fan-out across panes and keeping active/visible refresh responsibilities separated.

## Acceptance
- Active pane refresh stays on the fast lane only.
- Non-active visible panes refresh on a slower lane.
- Hidden panes do not participate in regular refresh cadence.
- Existing lifecycle, page, and render tests stay green.

## Scope
- In: `session-context-lifecycle` cadence split, associated tests, terminal page render-scope smoke.
- Out: daemon protocol changes, APK packaging changes, visual redesign.

## Implementation Notes
- Keep active tick single-target.
- Add passive-visible target helpers and slow cadence.
- Update red tests to reflect the new contract.

## Verification
- `pnpm --dir android exec vitest run src/contexts/session-context-lifecycle.test.tsx src/contexts/multi-pane-refresh.test.ts --reporter dot`
- `pnpm --dir android exec vitest run src/pages/TerminalPage.multi-pane-decouple.test.tsx src/pages/TerminalPage.render-scope.test.tsx --reporter dot`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`

## Done
- The active/visible refresh split is implemented and verified locally.
