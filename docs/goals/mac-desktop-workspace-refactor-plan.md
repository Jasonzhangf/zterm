# Mac Desktop Workspace Refactor Plan

## Goal

Keep the macOS desktop shell slice executable end to end: docs and gates first,
then workspace truth, runtime registry, file browser, and terminal transport.
This plan is the architecture-truth contract checked by
`mac/src/lib/mac-architecture-truth.test.ts`.

## Slice 0: Docs And Gates

- Keep `mac/docs/architecture.md` and `mac/docs/function-map.md` current.
- Anchor the mainline call map and lifecycle edges to real source symbols.
- Run `pnpm --dir mac run type-check`, `pnpm --dir mac run build`, and the
  architecture-truth tests before each production change.

## Slice 1: Workspace Truth

- `MacRuntimeRegistry` owns typed runtime records and workspace projection.
- `workbench-model` and `workspace-store` derive split-tree state from the same
  shared workspace primitives; no second mirror or renderer truth.
- Window lifecycle stays in `mac/electron/window-manager.ts`; renderer only
  reads `windowId` from the host.

## Slice 2: Native Bridge

- Local tmux transport remains the only local session capture owner.
- `preload.ts` exposes typed bridges only; renderer never imports Electron.
- `MacFileBrowser` consumes the file-system bridge and projects errors in the
  browser owner.

## Gate

- Positive and negative tests for window restore, workspace split/move, local
  tmux lifecycle, and file browser read/error states.
