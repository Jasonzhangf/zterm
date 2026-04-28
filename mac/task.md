# zterm Mac Task Board

## Epic-001 Rewrite truth freeze

- [x] T1 以 Android contract model 重写 Mac spec / architecture / dev-workflow
- [x] T2 建立 `mac/task.md` / `mac/CACHE.md`
- [x] T3 记录本轮第一刀 ownership 切法与验证结论

## Epic-002 App shell first cut

- [x] T1 停止以旧 `ShellWorkspace` 作为主入口
- [ ] T2 建立新的 terminal-first app shell
- [x] T3 建立 minimal launcher / editor / active tab 闭环
- [x] T4 接回真实 runtime 并验证 terminal surface

## Epic-003 Runtime contract cutover

- [x] T0 两阶段 session-transport-ticket 握手（bridge-connection.ts session-open → session-ticket → connect）

- [x] T1 审计 `mac/src/lib/terminal-runtime.ts` 与 Android 新 contract 的偏差
- [ ] T2 切出 Mac session head / buffer worker adapter（进行中：已接入 head-driven follow sync）
- [ ] T3 让 renderer 只消费新的 projection contract
- [ ] T4 删除旧 workspace/runtime 编排残留

## Epic-004 Desktop capabilities after contract

对应 Android Epic-003/004/005/006，将 Android 已验证功能同步到 Mac。
设计原则：**复用 shared 公共层，平台壳只补桌面特有能力，禁止复制第二套真相**。

- [x] T0 shared compact wire 类型 + normalizeWireLines + replayBufferSyncHistory（packages/shared）
- [x] T1 mac/scripts/daemon-loopback.ts 回环测试（initial-sync + local-input-echo 2/2 PASS）
- [x] T2 mac/scripts/run-daemon-loopback.sh runner

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

- [ ] T-D1 vertical split
  - ShellWorkspace 已有 splitActivePane（MAX_PANES=3），需验证真实 terminal surface 在 split pane 中���作
  - 验证：点击 split → 两个 terminal 各自独立连接 → 各自独立输入/输出
- [ ] T-D2 local tmux
  - ShellWorkspace 已有 local-tmux tab kind + localTransport，需验证完整闭环
  - 验证：选择本地 tmux session → 连接 → 输入/输出/resize 正常
- [ ] T-D3 schedule modal re-entry
  - ShellWorkspace 已有 scheduleModalOpen，需验证定时任务 CRUD 完整闭环
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
