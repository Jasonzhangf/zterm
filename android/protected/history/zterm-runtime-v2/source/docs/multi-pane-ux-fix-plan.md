# Multi-Pane UX 修复计划

## 问题列表

| # | 问题 | 根因 | 修改范围 |
|---|------|------|----------|
| 1 | session 连接警告 toast 跨多 pane 泄漏 | `showToast` 无 paneId 作用域，所有 pane 共享同一 quickbar 实例 | `TerminalQuickBar.tsx` + `session-context` props |
| 2 | adaptive 设置无法在 split 模式下对单 tab 操作 | pane tab 长按无 context menu | `pane-tabs.tsx` / `shared-pane-tabs.tsx` |
| 3 | 点击+ 添加 session 打开全屏 ConnectionsPage | `ConnectionFab` 跳全屏 page | quickbar 或 tab bar 附近内联窄 sheet |

## 执行顺序

### 阶段 1：toast pane 隔离（最小改动）
- `TerminalQuickBar` props 增加 `activePaneId?: string`
- `showToast` 调用时记录当前 paneId（通过 props 注入或 context）
- toast render 加 `data-active-pane-id` 归属判断
- 仅当 toast 归属当前 pane 时 render
- 红测：多 pane 场景切换 toast 显示源

### 阶段 2：pane tab 长按菜单
- 在 `shared-pane-tabs.tsx` / `pane-tabs.tsx` 增加 `onLongPressTab(tabId)` 回调
- App.tsx 层实现 context menu，选项：
  - `移动到 pane N`（显示所有其他 pane）
  - `adaptive-phone / mirror-fixed` 切换
  - `关闭 tab`
- 红测：长按 tab → 弹出菜单 → 选择后生效

### 阶段 3：添加 session 内联 sheet
- 新增 `AddSessionSheet.tsx`（窄边框 bottom sheet，半屏宽，贴近 tab bar）
- `TerminalQuickBar` 的 `+` 按钮改为打开此 sheet
- sheet 内容：最近 hosts 列表 + 新建 host 表单（inline）
- 不再跳 ConnectionsPage
- 红测：点击+ → sheet 出现 → 选 host → 打开 tab → sheet 关闭

## 验证门禁
1. `npx tsc --noEmit` 0 error
2. `pnpm --filter @zterm/android test` 全部 pass
3. `pnpm --filter @zterm/android build` 成功
4. APK 发布到 `update-dist/`
5. 功能红测逐项通过

## 当前源码状态（snapshot）
- HEAD: `8c52ef3` (fix/input: add null guards to composition session routing)
- APK latest: `0.1.3.1841`
- note.md 最新条目：renderer fix + composition session routing
