# zterm Mac Task Board

## Alpha readiness

- [x] 建立 `mac/docs/alpha-readiness.md`，把 Mac alpha 状态、已验证 baseline、P0/P1 缺口和必跑 packaged smoke 固化为可审计真源
- [ ] 关闭 P0 alpha blockers：`T-A1` / `T-A2` / `T-A3` / `T-A4` / `T-A5` / remote open / alpha package handoff / evidence retention
- [ ] 每次回答 Mac 状态或 alpha 距离前，先按 `.agents/skills/zterm-mac-dev/SKILL.md` 的状态对账门禁回扫 git、MEMORY、task、function map、test design 和 evidence

## Epic-001 Rewrite truth freeze

- [x] T1 以 Android contract model 重写 Mac spec / architecture / dev-workflow
- [x] T2 建立 `mac/task.md` / `mac/CACHE.md`
- [x] T3 记录本轮第一刀 ownership 切法与验证结论
- [x] T4 新增 `mac/docs/desktop-workspace-plan.md`，冻结多窗口 / 多服务器 / pane-tab-runtime owner 设计
- [x] T5 修正入口实现，使代码与当前 spec 的 production entrypoint 一致

## Epic-002 App shell first cut

- [x] T1 停止以旧 `ShellWorkspace` 作为主入口
- [x] T2 建立新的 `MacDesktopApp` production entrypoint
- [x] T3 建立 minimal launcher / editor / active tab 闭环
- [x] T4 接回真实 runtime 并验证 terminal surface
- [x] T5 物理删除旧 `ShellWorkspace` all-in-one 生产语义；`MacAppShell/MacPaneWorkbench` 只保留当前 verified owner path

## Epic-003 Runtime contract cutover

- [x] T0 两阶段 session-transport-ticket 握手（bridge-connection.ts session-open → session-ticket → connect）

- [x] T1 审计 `mac/src/lib/terminal-runtime.ts` 与 Android 新 contract 的偏差
- [ ] T2 切出 Mac session head / buffer worker adapter（进行中：已接入 head-driven follow sync）
- [ ] T3 让 renderer 只消费新的 projection contract
- [ ] T4 删除旧 workspace/runtime 编排残留
- [x] T5 新增 `MacRuntimeRegistry`，按 `runtimeKey -> TerminalRuntimeController` 管理独立 live pane runtime（白盒 + packaged A/B input/resize/switch/close smoke 已完成）

## Epic-004 Desktop workspace after contract

对应 `mac/docs/desktop-workspace-plan.md`，先做 owner 和 CI gate，再做桌面能力。
设计原则：**复用 shared 公共层，平台壳只补桌面特有能力，禁止复制第二套真相**。

- [x] T-0A `mac/docs/spec.md` / `mac/docs/architecture.md` / `mac/docs/desktop-workspace-plan.md` current baseline 对齐 `App -> MacDesktopApp -> MacAppShell`
- [x] T-0B 建立 `mac/docs/function-map.md` owner/function 查询入口
- [x] T-0C 建立 `mac/docs/mainline-call-map.json` lifecycle/call edge 机器真源
- [x] T-0D 建立 `mac/docs/testing/mac-desktop-workspace-test-design.md` 白盒/黑盒/运行态测试设计
- [x] T-0E 建立 Slice 0 architecture truth gate skeleton
- [x] T0 shared compact wire 类型 + normalizeWireLines + replayBufferSyncHistory（packages/shared）
- [x] T1 mac/scripts/daemon-loopback.ts 回环测试（initial-sync + local-input-echo 2/2 PASS）
- [x] T2 mac/scripts/run-daemon-loopback.sh runner
- [x] T3 `MacWorkspaceStore`：window/workspace/pane/tab 纯状态模型 + split/resize/move/activate 单测
- [x] T3R `MacRuntimeRegistry`：runtimeKey -> controller、connect once、active/idle、release、projection/input 路由白盒 gate（packaged A/B input/resize/switch/close live isolation 已闭环）
- [x] T4 `MacServerDirectory`：左侧多服务器 rail + saved/live projection 输入 + read-only remote daemon refresh + refresh/projection 不改 open tabs 的正反测试（packaged smoke 已闭环）
- [x] T5 `MacWindowManager`：Electron New Window + windowId + window-scoped workspace persistence + packaged quit/reopen restore smoke
- [x] T5F `MacFileBrowser`：shared FileBrowserCore + Electron fs adapter + MacFileBrowserPanel，覆盖本地 fixture 浏览、文本预览、二进制禁用、大文件确认（packaged fs smoke 已闭环）
- [x] T5L Legacy cleanup：物理删除 `ShellWorkspace.tsx` / `ShellWorkspace.split-tree.test.tsx` / `shell-workspace.ts`，architecture truth gate 锁不复活
- [ ] T6 Profiles / arrangements：profile 不含 live runtime，arrangement 不含 buffer truth

### P0 终端体验基础（Epic-004.A 核心连接 + 终端）

- [ ] T-A1 QuickConnectSheet session 自动发现补全
  - 连接成功后自动 fetchTmuxSessions → 预选最近连接的 session → 一键 open
  - 验证：QuickConnectSheet 输入 host/token → 发现 → 选中 → 连接 → 终端渲染
- [ ] T-A2 Tab 恢复持久化（OPEN_TABS / ACTIVE_SESSION localStorage 冷启动恢复）
  - 从 shared STORAGE_KEYS 读写，冷启动时恢复上次打开的 tab + 最后活跃 tab
  - 只允许 active tab eager connect，hidden tabs 仅恢复 shell 不建连
  - 验证：打开多个 tab → 关闭 app → 重启 → tab 恢复 → active tab 自动连接
- [ ] T-A3 TerminalHeader 状态显示补齐
  - 显示连接状态胶囊（idle/connecting/connected/error）+ session 名 + 分辨率
  - 断开/重连按钮
  - 验证：连接前后 header 状态切换��确
- [ ] T-A4 Buffer follow/reading 状态机验证
  - terminal-runtime 已有 follow/reading + missingRanges，需验证 renderer 端完整消费
  - 用户上滑进 reading、滚回底恢复 follow
  - 验证：输入命令产生大量输出 → 上滑进 reading → 新输出不抢滚 → 滚回底恢复 follow
- [ ] T-A5 断线自动重连
  - 断线后进入 error 状态 → 用户点击重连 或 自动退回到 idle → 可手动重新连接
  - 验证：daemon restart → Mac 客户端收到 closed → 显示 error → 点击重连 → 恢复

### P1 文件传输与截图（Epic-004.B 传输能力）

- [ ] T-B1 远程截图 UI 入口
  - daemon backend + screenshot helper 已通，Mac 需在 TerminalHeader 或菜单中添加截图按钮
  - 触发 remote-screenshot-request → capturing → transferring → preview → save/discard
  - 验证：点击截图 → 等待 preview → 保存 → 确认文件存在
- [ ] T-B2 图片粘贴 UI 入口
  - bridge-transport pasteImage 已有接口，需在 UI 中添加粘贴图片按钮或 Cmd+V 图片拦截
  - 验证：选择图片 → base64 发送 → daemon 写入剪贴板 → Ctrl+V 在终端粘贴
- [ ] T-B3 文件传输页（FileTransferSheet）
  - 复用 daemon 文件传输协议：远程目录浏览 + upload + download
  - Mac 端用 Electron dialog 替代 Android file picker
  - 验证：浏览远程目录 → 下载文件 → 上传文件 → 确认完整性

### P2 UI 增强（Epic-004.C 界面完善）

- [ ] T-C1 Settings 页面
  - 全局设置：terminal theme 选择 / cache lines / terminalWidthMode / daemon 配置
  - bridge settings 存储在 shared localStorage，Mac 只读写
  - 验证：切换 theme → 立即生效 → 重启后持久化
- [ ] T-C2 ConnectionPropertiesPage
  - 连接详情页：General / Tmux Session / Connection / Terminal / Appearance 分组
  - 复用 shared connection types 和 host storage
  - 验证：编辑连接属性 → 保存 → 回到列表 → 属性更新
- [ ] T-C3 Debug overlay（绝对行号 + follow/reading 状态浮窗）
  - 开关入口：TerminalHeader 状态按钮
  - 开启后 renderer 左侧显示绝对行号，右下角浮窗显示 follow/reading + viewport 范围
  - 验证：打开 debug → 终端有行号显示 → follow/reading 切换浮窗实时更新
- [ ] T-C4 终端快捷操作栏增强
  - Mac 桌面端不需要 Android QuickBar 的方向键，但需要 schedule 入口 + 文件/截图/设置快捷按钮
  - 复用 shared TerminalShortcutComposer 快捷键组合
  - 验证：快捷按钮可触发 schedule / screenshot / file-transfer

### P3 高级功能（Epic-004.D 桌面特有能力）

- [x] T-D1 vertical split
  - 新 production owner 已通过 packaged A/B runtime smoke 验证 split pane 独立连接、输入、resize、switch、close
  - 验证：点击 split → 两个 terminal 各自独立连接 → 各自独立输入/输出
- [x] T-D2 local tmux
  - 新 production owner 已用专用 `zterm_mac_goal_a/b` packaged smoke 验证 local tmux 完整闭环
  - 验证：选择本地 tmux session → 连接 → 输入/输出/resize 正常
- [ ] T-D3 schedule modal re-entry
  - 旧 all-in-one ShellWorkspace 已删除；schedule UI 需以独立 owner 重新接入并验证定时任务 CRUD 完整闭环
  - 验证：打开 schedule → 新增 → 列表显示 → 立即执行 → 删除
- [ ] T-D4 packaged smoke closeout
  - electron-builder 构建 → .app 安装 → 打开 → 连接 daemon → 终端渲染
  - 验证：pnpm run package → 拖到 Applications → 打开 → 连接成功
- [ ] T-D5 TerminalWidthMode 桌面适配
  - 桌面端默认 mirror-fixed（不改 daemon/tmux 宽度），renderer 做 crop/pan
  - 验证：设置 mirror-fixed → 窗口宽度变化 → 终端内容不被重排 → 可横向平移

## Epic-005 Session transport lifecycle 对齐

对应 Android mobile-15.32，Mac 也需要 session transport 解耦。

- [ ] T1 session-transport-runtime store（target runtime → control transport → session transport）
  - 同一 target 共享一条 control transport，每个 session 独立 session transport token
  - 复用 shared session-transport-ticket 协议
- [ ] T2 inactive tab 只停 head/range pull，不关 session / transport
- [ ] T3 daemon reconnect 复用同一 clientSessionId logical session
- [ ] T4 自动回归：same target multi-session / foreground resume / active re-entry

## Epic-006 Terminal renderer 收口

对应 Android Epic-006，Mac renderer 需切到与 Android 完全一致的 buffer truth 消费模型。

- [ ] T1 renderer 只消费 session buffer projection，不维护第二份 terminal 真相
- [ ] T2 compact wire roundtrip 验证（daemon 发 compact → Mac normalizeWireLines → renderer 显示）
- [ ] T3 cursor 状态回显（payload.cursor → renderer 不自行改样式）
- [ ] T4 reading gap repair（reading 模式下 missingRanges → 补请求 → 本地 buffer 填充）
- [ ] T5 renderer horizontal crop/pan（mirror-fixed 下长行左裁切，renderer 维护 horizontal render window）
- [ ] T6 自动回归：loopback test 扩展 follow/reading/gap-repair 用例
