# Browser remote-window mode

## Decision

The first browser experience is an existing-Chrome window projected through the
existing `desktop.remote_window_stream` media path. It does not launch Chrome,
create a profile, resize the host window, or create a second screencast/media
pipeline.

The Android client exposes a separate `Web` floating entry. The entry filters
the daemon app-window catalog to Chrome bundle identifiers and starts the
selected window directly in the existing fullscreen remote-window projection.

## Interaction boundary

- fullscreen and pinch zoom are client-side remote-window projection behavior;
- Chrome page input, navigation, and page zoom are out of scope for this slice;
- closing the overlay stops only the remote-window stream;
- the host Chrome process, profile, tab, and native window remain untouched;
- CDP target mapping and UA control are a later typed control-plane extension;
  they must not enter the video frame or remote-window input payload.

## Ownership

`daemon.remote_window_stream` remains the catalog, capture, WebRTC, and cleanup
owner. `client.remote_window_overlay` owns the browser entry/filter and the
fullscreen projection choice. No new browser process owner is introduced.

## Verification

- browser target classification accepts stable/beta/canary/dev Chrome bundle
  identifiers and rejects other app windows;
- browser picker projects only Chrome targets;
- browser selection produces `mode: fullscreen` while the normal remote-window
  selection remains `mode: floating`;
- existing remote-window runtime and type-check gates remain green.
