export type TransferSheetAvoidSide = "left" | "right" | null;

export const transferSheetOverlayStyle = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 92,
  background: "var(--zterm-sheet-overlay)",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "stretch",
};

export const transferSheetContainerStyle = {
  width: "100%",
  height: "88vh",
  display: "flex",
  flexDirection: "column" as const,
  borderTopLeftRadius: "20px",
  borderTopRightRadius: "20px",
  border: "1px solid var(--zterm-panel-border)",
  background: "var(--zterm-panel-bg)",
  color: "var(--zterm-panel-text)",
  boxShadow: "0 -16px 40px var(--zterm-panel-shadow)",
  overflow: "hidden",
};

export function buildTransferSheetContainerStyle(
  avoidSide: TransferSheetAvoidSide,
  mode: "browser" | "sync" = "sync",
) {
  const baseStyle = mode === "browser"
    ? {
      ...transferSheetContainerStyle,
      height: "auto",
      maxHeight: "88vh",
    }
    : transferSheetContainerStyle;
  if (!avoidSide) {
    return baseStyle;
  }
  return {
    ...baseStyle,
    width: "min(50vw, 560px)",
    height: mode === "browser" ? "auto" : "calc(100vh - 24px)",
    maxHeight: "calc(100vh - 24px)",
    borderRadius: "20px",
    borderTopLeftRadius: "20px",
    borderTopRightRadius: "20px",
  };
}

export function buildTransferSheetOverlayStyle(
  avoidSide: TransferSheetAvoidSide,
) {
  if (!avoidSide) {
    return transferSheetOverlayStyle;
  }
  return {
    ...transferSheetOverlayStyle,
    alignItems: "center",
    justifyContent: avoidSide === "left" ? "flex-end" : "flex-start",
    padding: "12px",
    background: "var(--zterm-sheet-overlay)",
  };
}
