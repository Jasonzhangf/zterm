import { describe, it, expect, beforeEach } from "vitest";
import { Renderer } from "../renderer.js";
import type { CellData, CursorState } from "@wterm/core";

function createMockBridge(cols: number, rows: number, grid: CellData[][] = []) {
  const dirtyRows = new Set<number>();
  for (let r = 0; r < rows; r++) dirtyRows.add(r);

  return {
    getCols: () => cols,
    getRows: () => rows,
    getCell: (row: number, col: number): CellData =>
      grid[row]?.[col] ?? { char: 0, fg: 256, bg: 256, flags: 0, width: 1 },
    isDirtyRow: (row: number) => dirtyRows.has(row),
    clearDirty: () => dirtyRows.clear(),
    getCursor: (): CursorState => ({ row: 0, col: 0, visible: true }),
    getScrollbackCount: () => 0,
    getScrollbackCell: (_offset: number, _col: number): CellData => ({
      char: 0,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }),
    getScrollbackLineLen: () => 0,
  };
}

function makeCell(
  char: string,
  fg = 256,
  bg = 256,
  flags = 0,
  width = 1,
): CellData {
  return { char: char.codePointAt(0)!, fg, bg, flags, width };
}

describe("Renderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  describe("setup", () => {
    it("creates row elements for each row", () => {
      const renderer = new Renderer(container);
      renderer.setup(80, 24);
      const rows = container.querySelectorAll(".term-row");
      expect(rows).toHaveLength(24);
    });

    it("clears previous content on re-setup", () => {
      const renderer = new Renderer(container);
      renderer.setup(80, 24);
      renderer.setup(40, 12);
      const rows = container.querySelectorAll(".term-row");
      expect(rows).toHaveLength(12);
    });
  });

  describe("render", () => {
    it("renders text content from bridge cells", () => {
      const grid = [[makeCell("H"), makeCell("i")]];
      const bridge = createMockBridge(2, 1, grid);
      const renderer = new Renderer(container);
      renderer.render(bridge as any);

      const text = container.textContent;
      expect(text).toContain("H");
      expect(text).toContain("i");
    });

    it("applies cursor class to cursor position", () => {
      const grid = [[makeCell("A"), makeCell("B")]];
      const bridge = createMockBridge(2, 1, grid);
      bridge.getCursor = () => ({ row: 0, col: 0, visible: true });
      const renderer = new Renderer(container);
      renderer.render(bridge as any);

      const cursor = container.querySelector(".term-cursor");
      expect(cursor).not.toBeNull();
      expect(cursor?.textContent).toBe("A");
    });

    it("keeps cursor on the correct cell for astral unicode chars", () => {
      const grid = [[makeCell("🙂"), makeCell("B")]];
      const bridge = createMockBridge(2, 1, grid);
      bridge.getCursor = () => ({ row: 0, col: 0, visible: true });
      const renderer = new Renderer(container);
      renderer.render(bridge as any);

      const cursor = container.querySelector(".term-cursor");
      expect(cursor).not.toBeNull();
      expect(cursor?.textContent).toBe("🙂");
      expect(container.textContent).toContain("🙂");
      expect(container.textContent).toContain("B");
    });

    it("renders wide cells from remote width truth without adding extra columns", () => {
      const grid = [[
        makeCell("你", 256, 256, 0, 2),
        { char: 32, fg: 256, bg: 256, flags: 0, width: 0 },
        makeCell("A"),
      ]];
      const bridge = createMockBridge(3, 1, grid);
      bridge.getCursor = () => ({ row: 0, col: 2, visible: true });
      const renderer = new Renderer(container);
      renderer.render(bridge as any);

      const row = container.querySelector(".term-row") as HTMLElement;
      const cells = row.querySelectorAll("span");
      expect(cells).toHaveLength(3);
      expect((cells[0] as HTMLElement).style.width).toBe("2ch");
      expect((cells[1] as HTMLElement).style.width).toBe("0px");
      expect(cells[2]?.classList.contains("term-cursor")).toBe(true);
    });

    it("re-renders on resize", () => {
      const bridge1 = createMockBridge(2, 1, [[makeCell("X")]]);
      const renderer = new Renderer(container);
      renderer.render(bridge1 as any);
      expect(container.querySelectorAll(".term-row")).toHaveLength(1);

      const bridge2 = createMockBridge(4, 3, []);
      renderer.render(bridge2 as any);
      expect(container.querySelectorAll(".term-row")).toHaveLength(3);
    });

    it("skips clean rows", () => {
      const grid = [[makeCell("A")]];
      const bridge = createMockBridge(1, 2, grid);
      const renderer = new Renderer(container);
      renderer.render(bridge as any);

      const rows = container.querySelectorAll(".term-row");
      const row1Text = rows[0].textContent;
      expect(row1Text).toContain("A");
    });

    it("applies styled spans for colored cells", () => {
      const grid = [[makeCell("C", 1, 256, 0)]];
      const bridge = createMockBridge(1, 1, grid);
      const renderer = new Renderer(container);
      renderer.render(bridge as any);

      const span = container.querySelector("span[style]");
      expect(span).not.toBeNull();
      expect(span?.getAttribute("style")).toContain("color:");
    });

    it("applies bold style via flags", () => {
      const FLAG_BOLD = 0x01;
      const grid = [[makeCell("B", 256, 256, FLAG_BOLD)]];
      const bridge = createMockBridge(1, 1, grid);
      const renderer = new Renderer(container);
      renderer.render(bridge as any);

      const span = container.querySelector("span[style]");
      expect(span?.getAttribute("style")).toMatch(/font-weight:\s*bold/);
    });
  });
});
