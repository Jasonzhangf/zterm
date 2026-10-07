// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZtermDialog } from "./ZtermDialog";

describe("ZtermDialog motion baseline", () => {
  afterEach(cleanup);

  it("exposes data-state hooks so transitions-dev recipes can target open vs closing frames", () => {
    render(<ZtermDialog open title="saved" onConfirm={vi.fn()} />);

    const overlay = screen.getByTestId("zterm-dialog");
    expect(overlay.getAttribute("data-state")).toBe("open");
  });

  it("reports closing state when the parent flips open=false", () => {
    const { rerender } = render(<ZtermDialog open title="saved" onConfirm={vi.fn()} />);
    rerender(<ZtermDialog open={false} title="saved" onConfirm={vi.fn()} />);

    const overlay = screen.getByTestId("zterm-dialog");
    expect(overlay.getAttribute("data-state")).toBe("closing");
  });

  it("keeps the exiting node on the body portal layer", () => {
    const { rerender } = render(
      <div data-testid="clipping-ancestor" style={{ transform: "translateZ(0)", overflow: "hidden" }}>
        <ZtermDialog open title="saved" onConfirm={vi.fn()} />
      </div>,
    );
    rerender(
      <div data-testid="clipping-ancestor" style={{ transform: "translateZ(0)", overflow: "hidden" }}>
        <ZtermDialog open={false} title="saved" onConfirm={vi.fn()} />
      </div>,
    );

    const overlay = screen.getByTestId("zterm-dialog");
    expect(overlay.getAttribute("data-state")).toBe("closing");
    expect(overlay.parentElement).toBe(document.body);
  });
});
