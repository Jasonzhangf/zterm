import { TerminalPort } from "../terminal-port.mjs";
import { snapshotToFrame, toFrameChunk } from "../terminal-port.mjs";
import { frameToAnsi, frameToText } from "../terminal-ansi-serializer.mjs";

// Public terminal surface. The port owns terminal lifecycle and projection;
// snapshotToFrame/toFrameChunk are pure adapters over a committed frame chunk
// and never expose internal stream or buffer state.
export {
  TerminalPort,
  snapshotToFrame,
  toFrameChunk,
  frameToAnsi,
  frameToText,
};
