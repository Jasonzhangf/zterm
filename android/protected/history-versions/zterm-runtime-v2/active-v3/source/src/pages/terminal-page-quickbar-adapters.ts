/**

 * quickbar props/type adapters for TerminalPageQuickBarAssembly

 * Converts page-level types to TerminalQuickBar consumer-level types.

 */

// shellMode: page layout profile uses "adaptive-phone"|"mirror-fixed"
// TerminalQuickBar expects "inline"|"floating-collapsed"
export function resolveQuickBarShellMode(
  profileShellMode: "adaptive-phone" | "mirror-fixed",
): "inline" | "floating-collapsed" {
  return profileShellMode === "adaptive-phone" ? "inline" : "floating-collapsed";
}

// remoteScreenshotStatus: page uses RemoteScreenshotPreviewState + resolveRemoteScreenshotQuickBarStatus
// TerminalQuickBar expects phase string union
export type QuickBarScreenshotPhase =
  | "idle"
  | "capturing"
  | "transferring"
  | "preview-ready"
  | "saving"
  | "failed"
  | null;

export function resolveQuickBarScreenshotPhase(
  previewState: { phase?: string } | null | undefined,
): QuickBarScreenshotPhase {
  if (!previewState?.phase) return null;
  const valid: QuickBarScreenshotPhase[] = [
    "idle",
    "capturing",
    "transferring",
    "preview-ready",
    "saving",
    "failed",
  ];
  return valid.includes(previewState.phase as QuickBarScreenshotPhase)
    ? (previewState.phase as QuickBarScreenshotPhase)
    : null;
}
