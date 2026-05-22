import { Capacitor, registerPlugin } from '@capacitor/core';
export interface DebugInputPayload { sessionId?: string; text?: string; newline?: string; ts?: number; }
export interface DebugInputPlugin {
  sendInput(options: { sessionId: string; text: string; newline?: string }): Promise<{ ok: boolean }>;
  addListener(eventName: 'debug-input', listenerFunc: (event: DebugInputPayload) => void): Promise<{ remove: () => Promise<void> }>;
}
export const DebugInput = registerPlugin<DebugInputPlugin>('DebugInput');
export function isDebugInputSupported() { const c:any=Capacitor as any; return typeof c?.isNativePlatform==='function' && c.isNativePlatform() && c.getPlatform?.()==='android'; }
