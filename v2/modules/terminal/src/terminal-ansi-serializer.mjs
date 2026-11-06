const DEFAULT_COLOR = 256;
const ESC = "\u001b";
const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;

function styleKey(cell) {
  return `${cell.fg}:${cell.bg}:${cell.flags}`;
}

function cellText(cell) {
  if (!cell || cell.width === 0) {
    return "";
  }
  if (cell.char >= 32) {
    return String.fromCodePoint(cell.char);
  }
  return " ";
}

function sgrFor(cell) {
  const codes = ["0"];
  if (cell.flags & FLAG_BOLD) {
    codes.push("1");
  }
  if (cell.flags & FLAG_DIM) {
    codes.push("2");
  }
  if (cell.flags & FLAG_ITALIC) {
    codes.push("3");
  }
  if (cell.flags & FLAG_UNDERLINE) {
    codes.push("4");
  }
  if (cell.flags & FLAG_REVERSE) {
    codes.push("7");
  }
  if (cell.flags & FLAG_INVISIBLE) {
    codes.push("8");
  }
  if (cell.flags & FLAG_STRIKETHROUGH) {
    codes.push("9");
  }
  if (cell.fg !== DEFAULT_COLOR) {
    codes.push(`38;5;${cell.fg}`);
  }
  if (cell.bg !== DEFAULT_COLOR) {
    codes.push(`48;5;${cell.bg}`);
  }
  return `${ESC}[${codes.join(";")}m`;
}

function visibleWindow(frame) {
  const rows = Number.isFinite(frame.rows) && frame.rows > 0 ? Math.floor(frame.rows) : 24;
  const end = Number.isFinite(frame.endIndex) ? frame.endIndex : frame.startIndex + rows;
  const visibleStart = Math.max(frame.startIndex, end - rows);
  return { rows, visibleStart, end };
}

function lineMap(frame) {
  const map = new Map();
  for (const line of frame.lines || []) {
    if (line && Array.isArray(line.cells)) {
      map.set(line.index, line.cells);
    }
  }
  return map;
}

/**
 * Serialize a committed, gap-free terminal snapshot into a full-screen ANSI
 * repaint for the published wterm renderer. This is a wire adapter only: it
 * preserves cell color, flags, wide characters, cursor position and
 * visibility, and holds no independent terminal state.
 */
export function frameToAnsi(frame) {
  const map = lineMap(frame);
  const { rows, visibleStart, end } = visibleWindow(frame);
  const out = [`${ESC}[?25l`, `${ESC}[2J`];
  for (let row = 0; row < rows; row += 1) {
    const index = visibleStart + row;
    if (index >= end) {
      break;
    }
    const cells = map.get(index);
    out.push(`${ESC}[${row + 1};1H`);
    if (cells) {
      let run = "";
      let currentKey = null;
      for (const cell of cells) {
        if (!cell || cell.width === 0) {
          continue;
        }
        const key = styleKey(cell);
        if (key !== currentKey) {
          if (run) {
            out.push(run);
          }
          out.push(sgrFor(cell));
          run = "";
          currentKey = key;
        }
        run += cellText(cell);
      }
      if (run) {
        out.push(run);
      }
      out.push(`${ESC}[0m`);
    }
  }
  if (frame.cursor) {
    const rowIndex = Number.isFinite(frame.cursor.rowIndex) ? Math.max(0, Math.floor(frame.cursor.rowIndex)) : 0;
    const col = Number.isFinite(frame.cursor.col) ? Math.max(0, Math.floor(frame.cursor.col)) : 0;
    out.push(`${ESC}[${rowIndex + 1};${col + 1}H`);
    out.push(frame.cursor.visible === false ? `${ESC}[?25l` : `${ESC}[?25h`);
  } else {
    out.push(`${ESC}[?25l`);
  }
  return out.join("");
}

/**
 * Plain-text projection of the same visible window, used for evidence and
 * comparisons. It never replaces the cell-accurate renderer path.
 */
export function frameToText(frame) {
  const map = lineMap(frame);
  const { rows, visibleStart, end } = visibleWindow(frame);
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    const index = visibleStart + row;
    if (index >= end) {
      break;
    }
    const cells = map.get(index);
    if (!cells) {
      lines.push("");
      continue;
    }
    let text = "";
    for (const cell of cells) {
      text += cellText(cell);
    }
    lines.push(text.replace(/\s+$/u, ""));
  }
  return lines.join("\n");
}
