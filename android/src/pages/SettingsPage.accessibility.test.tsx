// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { AppUpdateSection } from "../components/settings/AppUpdateSection";
import type { BridgeSettings } from "../lib/bridge-settings";
import { DEFAULT_TERMINAL_CACHE_LINES } from "../lib/mobile-config";

const baseSettings: BridgeSettings = {
  targetHost: "",
  targetPort: 3333,
  targetAuthToken: "",
  signalUrl: "",
  turnServerUrl: "",
  turnUsername: "",
  turnCredential: "",
  transportMode: "auto",
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  terminalThemeId: "classic-dark",
  terminalWidthMode: "mirror-fixed",
  terminalSessionGroupLayoutMode: "auto",
  shortcutSmartSort: true,
  servers: [],
  defaultServerId: undefined,
  traversalRelay: undefined,
};

function renderSettings(overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  return render(
    <SettingsPage
      settings={baseSettings}
      currentVersionName="0.1.3.2726"
      currentVersionCode={1100027260}
      updatePreferences={{
        manifestUrl: "",
        autoCheckOnLaunch: false,
        skippedVersionCode: undefined,
        ignoreUntilManualCheck: false,
        lastCheckedAt: undefined,
        lastSeenVersionCode: undefined,
      }}
      latestManifest={null}
      updateChecking={false}
      updateInstalling={false}
      updateError={null}
      hasNewVersion={false}
      hasUpdateIgnorePolicy={false}
      onSave={vi.fn()}
      onUpdatePreferencesChange={vi.fn()}
      onCheckForUpdate={vi.fn()}
      onInstallUpdate={vi.fn()}
      onResetUpdateIgnorePolicy={vi.fn()}
      onBack={vi.fn()}
      renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
      {...overrides}
    />,
  );
}

describe("SettingsPage accessibility baseline", () => {
  afterEach(cleanup);

  it("exposes a labelled back button for screen reader navigation", () => {
    const onBack = vi.fn();
    renderSettings({ onBack });

    const back = screen.getByRole("button", { name: "返回连接列表" });
    back.focus();
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("reports save feedback via aria-live so users know the save completed", async () => {
    const onSave = vi.fn();
    renderSettings({ onSave });

    const save = screen.getByRole("button", { name: "保存" });
    expect(save.hasAttribute("disabled")).toBe(false);
    save.focus();
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.textContent).toContain("已保存");
    });
  });

  it("keeps a settings group content region addressable for AT when expanded", () => {
    renderSettings();

    const groups = screen.getAllByTestId("settings-group");
    expect(groups.length).toBeGreaterThan(0);
    const firstOpen = groups.find((node) => node.hasAttribute("open")) ?? groups[0]!;
    const content = firstOpen.querySelector("[data-settings-group-content]");
    expect(content).not.toBeNull();
  });
});
