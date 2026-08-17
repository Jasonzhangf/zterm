# Copy Mode 拷贝功能审计 (2026-06-20)

## 现象
quickbar「拷贝」按钮可点击并高亮。但点击后长按 terminal 行没唤起应用内菜单，系统长按 effect 抢先弹出 Android 系统文本选择菜单。

## Git 历史（10 个关键 commit）

| Commit | 改动 | 真源修复 |
|--------|------|---------|
| `9c7e304` | feat: 增强复制功能与基线修复 | 首次实现 copy mode 长按菜单 |
| `da3d24a` | fix: restore system text selection for normal mode | user-select: text when !copyModeActive |
| `2ba484c` | fix: onClickCapture 在 pointerDown 立即设起始行 | tap start row 即时 |
| `38db24f` | refactor: decompose TerminalPage into blocks | 抽出 useTerminalPageCopyRuntime + VisibleRow |
| `7bd7b4e` | debug: add memo comparison log for copyModeActive | 排查按钮状态（debug 阶段） |
| `daa7f58` | fix(copy): remove broken memo | 移除坏 memo |
| `3b23872` | fix(copy): remove broken memo comparison | 同上，落地 |
| `ce83e80` | debug(copy): add console logs | 调试 toggle 路径 |
| `1916fc6` | copy mode closeout | 把 console.log 删掉 + 加 state-machine 红测 |
| `1f360f5` | R5 client useEffect storm | **加三层 capture 监听器防 native callout** |

## 代码现状（HEAD = 8c52ef3）

### Three-Layer Native Callout Blocker（拷贝功能核心防护）

**Layer 1 — CSS 注入**（`TerminalView.tsx` line ~1488）：
```tsx
{`.wterm[data-copy-mode="true"] [data-terminal-row="true"]{
-webkit-touch-callout:none;
-webkit-user-select:none;
user-select:none;
}`}
```

**Layer 2 — React capture prop**（TerminalView.tsx 1341-1344, 1388-1390）：
```tsx
onPointerDownCapture={preventNativeCopyGestureDefault}
onTouchStartCapture={preventNativeCopyGestureDefault}
onMouseDownCapture={preventNativeCopyGestureDefault}
onContextMenu={suppressNativeCopyMenu}
```

**Layer 3 — Native DOM listener**（TerminalView.tsx 1061-1082）：
```tsx
useEffect([copyModeActive]) {
const host = containerRef.current;
if (!host || !copyModeActive) return;
const options: AddEventListenerOptions = { capture: true, passive: false };
host.addEventListener('touchstart', preventNativeCallout, options);
host.addEventListener('contextmenu', suppressNativeMenu, options);
host.addEventListener('selectstart', suppressNativeMenu, options);
return () => { host.removeEventListener(...); };
}
```

### Row-Level Long-Press（仅 copyModeActive 时绑定）
```tsx
<VisibleRow
copyModeActive={copyModeActive}
onPointerDown={(e) => startCopyLongPress(e, rowIndex)} // 420ms timer
onTouchStart={(e) => startCopyLongPressTouch(e, rowIndex)} // 420ms timer
...
/>
```

### State Machine Hook（useTerminalPageCopyRuntime.ts）
```ts
const [copySelection, setCopySelection] = useState(EMPTY)
// IDLE → ACTIVE: handleQuickBarToggleCopyMode()
// ACTIVE → ACTIVE_MENU: handleLongPressCopyRow(sid, row, x, y)
// ACTIVE_MENU → IDLE: handleCopySelectedText() → writeTextToClipboard
```

### 红测（验证通过）
- `src/components/terminal/system-copy-state-machine.test.tsx`: **7/7 PASS**
- `src/components/terminal/system-copy-longpress-regression.test.tsx`: **2/2 PASS**
- 锁住 capture listener 注册、touch event 路径、user-select CSS

## 失灵真因（按概率排序）

### 原因 1（高概率）：TerminalQuickBar `blockShellEvent` 抢先拦截
**真源：`android/src/components/terminal/TerminalQuickBar.tsx:1590-1620`**

```tsx
const blockShellEvent = (event) => {
if (quickBarAllowsTarget(target)) return;
event.stopPropagation();
event.preventDefault();
};

// 应用到 quickbar 容器 root（line 1606）
onPointerDownCapture={(event) => blockShellEvent(event)}
onTouchStartCapture={(event) => blockShellEvent(event)}
onMouseDownCapture={(event) => blockShellEvent(event)}
onClickCapture={(event) => blockShellEvent(event)}
```

quickbar 是浮层（floating-collapsed 或 inline 模式），覆盖在 terminal viewport 上面。其 capture 阶段对 **所有** pointer/touch/click 都 `stopPropagation + preventDefault`。

**事件路径**：
1. 用户长按 terminal 行 → 实际 hit 到 quickbar overlay（不是 terminal）
2. quickbar capture 阶段 → `blockShellEvent` → `stopPropagation` + `preventDefault`
3. 事件不再传播到 TerminalView 的 row long-press handler
4. 420ms 计时器永不启动
5. 系统 WebView 长按 effect（contextmenu / selectstart）抢先弹系统菜单

**快速验证**：在真机长按一行 → 看 logcat 是否有 `TouchEvent` 进入 TerminalView 的 host listener。如果 quickbar 是顶层 cover，肯定没进入。

**修复方向**：
- `quickBarAllowsTarget` 增加白名单：`[data-terminal-row="true"]` → true（允许穿透到 terminal row）
- 或者 quickbar 的 capture handler 只对 quickbar 内部 button/input 生效，对其他 target 不 stopPropagation

### 原因 2（中概率）：React 18 strict mode 双跑 effect
TerminalView 的 `useEffect([copyModeActive])` 注册 capture listener。如果 dev build 开了 strict mode：
- mount → 注册 listener
- immediate cleanup → 移除 listener
- immediate remount → 重新注册

但 quickbar 也有 React strict mode 同步问题。如果 `blockShellEvent` 在 capture 阶段被注册到 quickbar 容器，strict mode 双跑也可能导致 listener 注册/反注册时序错乱。

**修复方向**：production build 验证（非 dev build）。

### 原因 3（低概率）：APK 未含 1f360f5 的 TerminalView
- `1f360f5` 引入 capture listener（关键三层防护之一）
- 用户报失灵 → 需验证 `0.1.3.1841` 是否含 1f360f5 之后的 TerminalView.tsx
- 1842 之后的 APK 应该都含

## 推荐修复（按优先级）

### Fix A：quickbar 允许 terminal row 穿透
```tsx
const quickBarAllowsTarget = (target: HTMLElement | null) => {
if (target?.closest('[data-quickbar-allow-pointer="true"]')) return true;
if (target?.closest('input,textarea,button,select,label')) return true;
// CRITICAL: allow terminal row events to pass through to TerminalView
if (target?.closest('[data-terminal-row="true"]')) return true;
return false;
};
```

### Fix B：lock terminal row 不被 quickbar capture 拦截
给 quickbar 的 capture handler 加 row-class 检测 → row 不在 quickbar 内部 → 不 stopPropagation。

### Fix C：移除 quickbar 全局 capture 拦截
quickbar 内部 button 用 stopPropagation 即可，不需要在容器 root 拦截整个 capture 链。

## Function Map（已落 android/docs/copy-function-map.md）

| Field | Value |
|-------|-------|
| Feature ID | `copy-mode-longpress` |
| Owner module | TerminalPage → useTerminalPageCopyRuntime → TerminalView → VisibleRow |
| Allowed paths | quickbar toggle / row long-press / start row tap |
| Blocked paths | system callout / context menu / selectstart |
| Gates | 5 个（已实现 + 红测锁住） |
| Verification | tsc 0 error；9 红测 pass |

## 待办

1. **核心修复**：quickbar `quickBarAllowsTarget` 加 `data-terminal-row` 白名单
2. **验证门禁**：补红测模拟 long-press 命中 row → 期望 onLongPressRow 被调用，不被 quickbar 拦截
3. **构建 APK**：修复后出包测试
4. **真机验证**：state-overlay 浮窗打 `event.defaultPrevented` / `event.target` debug
