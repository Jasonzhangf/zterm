import { memo, type CSSProperties } from "react";
import {
  buildTerminalVisibleRowViewModel,
  isBlockShadeCodePoint,
} from "@zterm/shared";
import type { TerminalThemePreset } from "@zterm/shared";
import type { TerminalCell } from "../../lib/types";

interface TerminalPreviewRowProps {
  absoluteIndex: number;
  row: TerminalCell[];
  isGap: boolean;
  rowHeight: string;
  cellWidthPx: number;
  theme: TerminalThemePreset;
  plainText: string;
}

function previewRunKey(cell: {
  fg?: number;
  bg?: number;
  flags?: number;
  width?: number;
  char?: number | string;
}) {
  // terminalCellStyle is deterministic for fg/bg/flags/width. Block glyphs also
  // depend on the exact glyph, so keep those runs separate instead of mixing
  // different background builds.
  const codePoint = typeof cell.char === "number"
    ? cell.char
    : typeof cell.char === "string" && cell.char.length > 0
      ? cell.char.codePointAt(0) || 32
      : 32;
  const blockSuffix = isBlockShadeCodePoint(codePoint) ? String(codePoint) : "";
  return `${cell.fg ?? 256}:${cell.bg ?? 256}:${cell.flags ?? 0}:${cell.width ?? 1}:${blockSuffix}`;
}

export const TerminalPreviewRow = memo(function TerminalPreviewRow({
  absoluteIndex,
  row,
  isGap,
  rowHeight,
  cellWidthPx,
  theme,
  plainText,
}: TerminalPreviewRowProps) {
  const viewModel = buildTerminalVisibleRowViewModel({
    absoluteIndex,
    row,
    rowHeight,
    cellWidthPx,
    isGap,
    theme,
    cursorColumn: -1,
  });

  const rowStyle: CSSProperties = {
    ...viewModel.rowStyle,
    minHeight: rowHeight,
    background: "transparent",
    color: theme.foreground,
    overflow: "hidden",
    textOverflow: "clip",
  };

  if (viewModel.kind === "gap") {
    return (
      <div
        data-terminal-row="true"
        data-terminal-preview-row="true"
        data-terminal-gap="true"
        data-terminal-index={absoluteIndex}
        data-terminal-row-text={plainText}
        style={rowStyle}
      >
        {plainText || "\u00a0"}
      </div>
    );
  }

  const runs: Array<{
    key: string;
    text: string;
    style: CSSProperties;
    widthPx: number;
  }> = [];
  for (let index = 0; index < row.length; index += 1) {
    const sourceCell = row[index];
    const renderedCell = viewModel.cells[index];
    if (!sourceCell || !renderedCell) {
      continue;
    }
    const key = previewRunKey(sourceCell);
    const widthPx = Math.max(0, Number.parseFloat(String(renderedCell.style.width || "0")) || 0);
    const currentRun = runs[runs.length - 1];
    if (currentRun && currentRun.key === key) {
      currentRun.text += renderedCell.char;
      currentRun.widthPx += widthPx;
    } else {
      runs.push({
        key,
        text: renderedCell.char,
        style: renderedCell.style,
        widthPx,
      });
    }
  }

  return (
    <div
      data-terminal-row="true"
      data-terminal-preview-row="true"
      data-terminal-index={absoluteIndex}
      data-terminal-row-text={plainText}
      style={rowStyle}
    >
      <span {...viewModel.cellWrapProps}>
        {runs.length > 0
          ? runs.map((run, runIndex) => (
              <span
                key={`${absoluteIndex}-preview-run-${runIndex}`}
                style={{
                  ...run.style,
                  width: `${run.widthPx}px`,
                }}
              >
                {run.text}
              </span>
            ))
          : "\u00a0"}
      </span>
    </div>
  );
}, (prev, next) => (
  prev.absoluteIndex === next.absoluteIndex
  && prev.row === next.row
  && prev.isGap === next.isGap
  && prev.rowHeight === next.rowHeight
  && prev.cellWidthPx === next.cellWidthPx
  && prev.theme === next.theme
  && prev.plainText === next.plainText
));
