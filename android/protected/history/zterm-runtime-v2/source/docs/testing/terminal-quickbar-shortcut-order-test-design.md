# Terminal QuickBar Shortcut Order Test Design

## Scope

- Feature: `terminal.quickbar`
- Owners: `TerminalQuickBar.tsx`, `terminal-quickbar-helpers.tsx`,
  `useShortcutActionStorage.ts`, `terminal-shortcut-actions.ts`
- Resources: `resource.ui_projection -> resource.platform_input_channel`
- Forbidden: renderer, daemon, transport, tmux, and shared connection protocol

## Lifecycle

```text
canonical built-ins + stored custom shortcuts
-> storage normalization and legacy merge
-> one ordered TerminalShortcutAction[] truth
-> QuickBar row projection
-> editor row reorder
-> persisted ordered truth
```

Built-in shortcuts have stable IDs and share row-local order with custom
shortcuts. The editor may reorder built-ins but cannot edit or delete them.

## Positive Gates

- Empty storage seeds all canonical built-ins in default row order.
- Legacy custom-only storage retains custom actions and appends missing
  built-ins without changing custom payload.
- Persisted built-in order survives storage reload.
- Built-ins and custom actions appear in one editor list and use one reorder
  operation.
- QuickBar visible rows follow persisted order.

## Negative Gates

- Built-ins cannot be edited or deleted.
- Duplicate shortcut sequences render once.
- Reordering does not change shortcut sequence, row classification, terminal
  input behavior, or either row-local `+` editor entry.
- No renderer, daemon, transport, or protocol owner is changed.

## Required Verification

- `src/hooks/useShortcutActionStorage.test.tsx`
- `src/components/terminal/TerminalQuickBar.test.tsx`
- `packages/shared/src/shortcuts/terminal-shortcut-composer.test.ts`
- `src/pages/TerminalPage.real-quickbar-split.test.tsx`
- `src/hooks/useTerminalWorkspace.test.tsx`
- `type-check`
- `test:feature-registry`
- Android build, OTA publication, installed-device UI proof
