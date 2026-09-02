# Remote files + web bottom sheet

## Goal

Provide one responsive resource surface in the terminal page that hosts remote
files, web rendering, and remote-window streaming without creating another
transport or file-transfer implementation. Phones use a bottom drawer; tablets
and desktop use a right-side drawer.

## Ownership and boundaries

- `client.terminal_shell` owns the drawer shell, tab selection, URL input, and
  iframe lifecycle under feature `client.resource_bottom_sheet`.
- `client.file_browser` remains the only owner of remote/local file transfer;
  the drawer receives its typed `renderFileBrowser` slot and never touches
  transport or file payloads.
- Web content is renderer-only: a validated `http:`/`https:` URL is loaded in
  an iframe with an explicit sandbox. It is not a daemon resource and cannot
  issue terminal or file commands through the drawer.
- The drawer is mounted by `TerminalPage`, above the terminal shell, and uses
  existing theme variables and bottom-sheet geometry tokens.
- Remote-window streaming is rendered through the same resource surface. The
  stream tab is the phone multi-window preview surface; on tablet/desktop the
  right-side drawer can show the grouped stream layout and focus a selected
  window. Existing stream transport and controller state remain authoritative.

## Interaction contract

- Opening the file action opens the drawer on the Files tab.
- Files, Stream, and Web are sibling tabs; changing tabs does not recreate the terminal
  session or transport.
- Closing the drawer always returns to the exact terminal layout shown before
  opening it; reopening starts from the resource tab selected by the entry.
- Web URL navigation is explicit (submit/Go), rejects non-http(s) schemes, and
  preserves the last valid URL while showing an inline error for invalid input.
- Backdrop, close button, and downward swipe close the drawer. Content scroll is
  independent from drawer dismissal.
- The file slot receives `open=true` only on the Files tab, so its existing
  lifecycle remains authoritative.

## Acceptance gates

- Drawer tests cover open/close, tab switching, file slot projection, valid URL
  navigation, invalid scheme rejection, and iframe sandbox/referrer policy.
- Existing file-browser, terminal-shell, type-check, feature-registry and
  build gates remain green.
- Emulator smoke confirms the drawer appears from the terminal, both tabs are
  usable, and no second socket/session is created.
