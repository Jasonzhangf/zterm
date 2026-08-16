import { Capacitor, registerPlugin } from "@capacitor/core";

export interface DeviceClipboardPlugin {
  readText(): Promise<{ value: string }>;
  writeText(options: { value: string }): Promise<void>;
}

const DeviceClipboardNative =
  registerPlugin<DeviceClipboardPlugin>("DeviceClipboard");

export function isNativeClipboardSupported() {
  return Capacitor.getPlatform() === "android";
}

export const DeviceClipboardPlugin = DeviceClipboardNative;
