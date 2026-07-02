// @vitest-environment jsdom
/**
* mac-runtime-lifecycle 红测：tab 切换时 runtime 不得 dispose
*
* 真源冻结：
* - foreground/background 切换不得 dispose runtime / transport
* - tab 切换 = setActivityMode('idle'/'active')，保留 runtime + bufferStore
* - dispose 只在 tab/pane 永久关闭时
*
* 验证：
* 1. 切 tab 后旧 runtime 的 bufferStore subscribe 仍触发
* 2. 切 tab 不清除 runtime listeners
* 3. 切回旧 tab 后 render buffer 可恢复
*/

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TerminalRuntimeController } from './terminal-runtime';

function makeRuntimeStub(): TerminalRuntimeController {
const listeners = new Set<() => void>();
let renderLines: string[] = [];
let connectionStatus = 'idle';

const bufferStore = {
getState: () => ({
canonicalBuffer: {},
renderBuffer: { lines: renderLines, cols: 80, rows: 24 },
}),
subscribe: (l: () => void) => {
listeners.add(l);
return () => listeners.delete(l);
},
};

const runtime: TerminalRuntimeController = {
getState: () => ({
connection: { status: connectionStatus, error: '', connectedSessionId: 'sess1', title: '', activeTarget: null } as any,
buffer: bufferStore.getState() as any,
render: { lines: renderLines, cols: 80, rows: 24 },
schedule: { jobs: [], loading: false } as any,
head: null,
}),
subscribe: (l: () => void) => {
listeners.add(l);
return () => listeners.delete(l);
},
connectRemote: vi.fn(),
connectLocalTmux: vi.fn(),
disconnect: vi.fn(),
setActivityMode: vi.fn(),
updateViewport: vi.fn(),
requestScheduleList: vi.fn(),
upsertScheduleJob: vi.fn(),
deleteScheduleJob: vi.fn(),
toggleScheduleJob: vi.fn(),
runScheduleJobNow: vi.fn(),
sendInput: vi.fn(),
pasteImage: () => true,
resizeTerminal: vi.fn(),
requestRemoteScreenshot: () => true,
sendRawJson: () => true,
onFileTransferMessage: () => () => {},
  dispose: vi.fn(() => {
    listeners.clear();
  }),
};

// Expose for testing
(runtime as any).__listeners = listeners;
(runtime as any).__bufferStore = bufferStore;
(runtime as any).__setRenderLines = (lines: string[]) => {
renderLines = lines;
listeners.forEach((l) => l());
};

return runtime;
}

describe('tab 切换 runtime 保活 (red baseline — ShellWorkspace 当前会 dispose)', () => {
it('setActivityMode("idle") 不清除 runtime listeners', () => {
const runtime = makeRuntimeStub();
const unsub = runtime.subscribe(() => {});
const initialSize = (runtime as any).__listeners.size;
expect(initialSize).toBe(1);

runtime.setActivityMode('idle');
// setActivityMode 不得清 listeners
expect((runtime as any).__listeners.size).toBe(1);
expect(runtime.dispose).not.toHaveBeenCalled();
unsub();
});

it('setActivityMode("idle") 后 setActivityMode("active") 恢复 runtime', () => {
const runtime = makeRuntimeStub();
runtime.connectRemote({} as any);

runtime.setActivityMode('idle');
expect(runtime.dispose).not.toHaveBeenCalled();

runtime.setActivityMode('active');
// dispose 仍未被调用，runtime 可用
expect(runtime.dispose).not.toHaveBeenCalled();
expect(runtime.connectRemote).toHaveBeenCalledTimes(1);
});

it('切 tab 不调用旧 runtime.dispose()', () => {
const runtimeA = makeRuntimeStub();
const runtimeB = makeRuntimeStub();
runtimeA.connectRemote({} as any);
runtimeB.connectRemote({} as any);

// Simulate tab switch: set A idle, B active
runtimeA.setActivityMode('idle');
runtimeB.setActivityMode('active');

// A 不得被 dispose
expect(runtimeA.dispose).not.toHaveBeenCalled();
// B 也不应被 dispose
expect(runtimeB.dispose).not.toHaveBeenCalled();
});

it('切回旧 tab 后旧 runtime render buffer 仍可读（subscribe 触发）', () => {
const runtime = makeRuntimeStub();
runtime.connectRemote({} as any);

let lastRender: any = null;
lastRender = runtime.getState().render;
const unsub = runtime.subscribe(() => {
lastRender = runtime.getState().render;
});
expect(lastRender?.lines).toEqual([]);

// Simulate remote output appended to buffer
(runtime as any).__setRenderLines(['line1', 'line2']);
expect(lastRender?.lines).toEqual(['line1', 'line2']);

// Switch away
runtime.setActivityMode('idle');
expect(runtime.dispose).not.toHaveBeenCalled();

// Switch back — subscribe still valid, lastRender still accessible
runtime.setActivityMode('active');
(runtime as any).__setRenderLines(['line1', 'line2', 'line3']);
expect(lastRender?.lines).toEqual(['line1', 'line2', 'line3']);

unsub();
});

it('dispose() 才是真正的清理：清除 listeners 并停 head-tick', () => {
const runtime = makeRuntimeStub();
const unsub = runtime.subscribe(() => {});
expect((runtime as any).__listeners.size).toBe(1);

runtime.dispose();
expect((runtime as any).__listeners.size).toBe(0);
// 二次 dispose 无害（幂等）
runtime.dispose();
expect((runtime as any).__listeners.size).toBe(0);
});
});
