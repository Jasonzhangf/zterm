// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "./ConnectionsPage";

describe("ConnectionsPage accessibility and motion baseline", () => {
  afterEach(cleanup);

  it("exposes a primary CTA and guidance when no servers are configured", () => {
    const onOpenSettings = vi.fn();
    render(<ConnectionsPage onOpenSettings={onOpenSettings} />);

    const emptyState = screen.getByTestId("connections-empty-state");
    expect(emptyState.textContent).toMatch(/配置第一台服务器/);

    const cta = screen.getByRole("button", { name: "添加第一台服务器" });
    expect(cta).toBeTruthy();
    cta.focus();
    expect(document.activeElement).toBe(cta);
    fireEvent.click(cta);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("uses an svg icon, not a raw plus character, for the add-server entry", () => {
    render(<ConnectionsPage onOpenSettings={vi.fn()} />);

    const cta = screen.getByRole("button", { name: "配置服务器" });
    expect(cta.querySelector("svg")).not.toBeNull();
  });

  it("keeps the saved connection list usable on a desktop viewport width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });

    render(<ConnectionsPage onOpenSettings={vi.fn()} />);

    expect(screen.getByTestId("connections-home").className).toContain("connections-home-shell");
  });

  it("focuses and consumes a one-time Settings return request on its own entry ref", () => {
    const onFocusSettingsButtonConsumed = vi.fn();
    const view = render(
      <ConnectionsPage
        onOpenSettings={vi.fn()}
        focusSettingsButtonNonce={1}
        onFocusSettingsButtonConsumed={onFocusSettingsButtonConsumed}
      />,
    );

    const settingsEntry = screen.getByRole("button", { name: "设置和升级" });
    expect(document.activeElement).toBe(settingsEntry);
    expect(onFocusSettingsButtonConsumed).toHaveBeenCalledTimes(1);

    act(() => {
      view.rerender(
        <ConnectionsPage
          onOpenSettings={vi.fn()}
          focusSettingsButtonNonce={0}
          onFocusSettingsButtonConsumed={onFocusSettingsButtonConsumed}
        />,
      );
    });
    expect(document.activeElement).toBe(settingsEntry);
    expect(onFocusSettingsButtonConsumed).toHaveBeenCalledTimes(1);
  });
});
