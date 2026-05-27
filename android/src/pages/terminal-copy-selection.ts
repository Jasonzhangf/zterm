import type { Session, SessionRenderBufferSnapshot } from "../lib/types";
import type { SessionRenderBufferStore } from "../lib/session-render-buffer-store";
import { DeviceClipboardPlugin, isNativeClipboardSupported } from "../plugins/DeviceClipboardPlugin";

export type CopySelectionState = {
  active: boolean;
  sessionId: string | null;
  startRowIndex: number | null;
  endRowIndex: number | null;
  menu: { x: number; y: number; rowIndex: number } | null;
};

export const EMPTY_COPY_SELECTION_STATE: CopySelectionState = {
  active: false,
  sessionId: null,
  startRowIndex: null,
  endRowIndex: null,
  menu: null,
};

export function terminalCellToPlainText(
  cell: { char?: number; width?: number } | null | undefined,
) {
  if (!cell || cell.width === 0) {
    return "";
  }
  const codePoint =
    typeof cell.char === "number" && Number.isFinite(cell.char)
      ? cell.char
      : 32;
  return String.fromCodePoint(codePoint);
}

export function terminalBufferRowsToPlainText(
  buffer: SessionRenderBufferSnapshot | null,
  startRowIndex: number,
  endRowIndex: number,
) {
  if (!buffer) {
    return "";
  }
  const from = Math.min(startRowIndex, endRowIndex);
  const to = Math.max(startRowIndex, endRowIndex);
  const lines = buffer.lines || [];
  const startIndex = buffer.startIndex ?? 0;
  const selectedRows: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const row = lines[index - startIndex] || [];
    selectedRows.push(
      row.map(terminalCellToPlainText).join("").replace(/\s+$/u, ""),
    );
  }
  return selectedRows.join("\n");
}

export function terminalBufferCoversRows(
  buffer: SessionRenderBufferSnapshot | null | undefined,
  startRowIndex: number,
  endRowIndex: number,
) {
  if (!buffer || !buffer.lines.length) {
    return false;
  }
  const from = Math.min(startRowIndex, endRowIndex);
  const to = Math.max(startRowIndex, endRowIndex);
  return buffer.startIndex <= from && buffer.startIndex + buffer.lines.length > to;
}

export function resolveCopySelectionBuffer(
  sessionBufferStore: SessionRenderBufferStore | null | undefined,
  sessions: Session[],
  sessionId: string,
  startRowIndex: number,
  endRowIndex: number,
): SessionRenderBufferSnapshot | null {
  const renderBuffer = sessionBufferStore?.getSnapshot(sessionId).buffer;
  if (
    renderBuffer &&
    terminalBufferCoversRows(renderBuffer, startRowIndex, endRowIndex)
  ) {
    return renderBuffer;
  }
  const sessionBuffer = sessions.find((session) => session.id === sessionId)
    ?.buffer as SessionRenderBufferSnapshot | undefined;
  if (
    sessionBuffer &&
    terminalBufferCoversRows(sessionBuffer, startRowIndex, endRowIndex)
  ) {
    return sessionBuffer;
  }
  return null;
}

export async function writeTextToClipboard(text: string) {
  if (isNativeClipboardSupported()) {
    await DeviceClipboardPlugin.writeText({ value: text });
    return;
  }
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable");
  }
  await navigator.clipboard.writeText(text);
}

export function logAsyncCleanupFailure(scope: string, error: unknown) {
  console.warn(`[TerminalPage] ${scope} failed:`, error);
}
