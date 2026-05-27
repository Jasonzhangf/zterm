import { mobileTheme } from "../../lib/mobile-ui";

export type TransferSheetAvoidSide = "left" | "right" | null;

export const transferSheetOverlayStyle = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 92,
  background: "rgba(5, 8, 14, 0.82)",
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
  border: `1px solid ${mobileTheme.colors.cardBorder}`,
  background: mobileTheme.colors.shell,
  boxShadow: "0 -16px 40px rgba(0,0,0,0.32)",
  overflow: "hidden",
};

export function buildTransferSheetContainerStyle(
  avoidSide: TransferSheetAvoidSide,
) {
  if (!avoidSide) {
    return transferSheetContainerStyle;
  }
  return {
    ...transferSheetContainerStyle,
    width: "min(50vw, 560px)",
    height: "calc(100vh - 24px)",
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
    background: "rgba(5, 8, 14, 0.34)",
  };
}
