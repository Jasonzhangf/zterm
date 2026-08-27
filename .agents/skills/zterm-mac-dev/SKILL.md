---
name: zterm-mac-dev
description: "zterm Mac 客户端开发工作流 - Electron 壳、terminal renderer、local/remote tmux、自闭环验证"
---

# zterm-mac Dev Skill

## 适用场景
- `mac/` 下的 Electron / renderer / preload / local tmux / remote bridge 开发
- Mac terminal 渲染、分屏、tab、local tmux、remote 连接、资源占用审计
- 用户要求先自测闭环、拿证据，再让 Jason 手测

---

## 一、必读顺序
1. `~/.codex/AGENTS.md`
2. `~/.codex/USER.md`
3. `coding-principals/SKILL.md`
4. `android/docs/decisions/0001-cross-platform-layout-profile.md`
5. `android/docs/architecture.md`
6. `android/docs/dev-workflow.md`
7. `mac/MEMORY.md`
8. 本 `SKILL.md`

---

## 二、Mac 开发硬规则

### 2.0 Skill 使用边界
- 本仓库 Mac 线默认只使用这一个项目 dev skill：`zterm-mac-dev`。
- 不要再为同一条 Mac 开发链路额外切换/串联新的本地 dev skill，避免规则分叉。
- 若确实需要别的 skill，必须是 Jason 显式点名。


### 2.1 Terminal / renderer
- renderer 只消费 canonical buffer / render projection；禁止在 view 层继续造第二份 terminal 真相。
- terminal 优先 terminal-first：少 chrome、少常驻面板、主空间给 terminal pane/tab/split。
- 分屏默认是一行多列、垂直分屏；不要把上下堆叠当主方案。
- Mac 分屏视觉压缩只改 shared `PaneStage` / `resolvePaneProfile` token 与 Mac shell chrome CSS；禁止在 runtime / renderer / buffer 层补外观。验证至少跑 pane targeted tests、type-check/build，并用渲染 smoke 证明 split DOM 与 spacing token（如 stage gap / divider width）已进入最新 bundle。
- reading/backfill 里 `missingRanges` 必须从 view -> runtime -> transport 原样透传；任一层清空它，scroll prefetch 都会静默失效。
- 若桌面端要接快捷按键组合语义，优先复用 shared composer 叶子模块；不要在 Mac renderer 再复制一套 `Ctrl + 字母` 编码/默认 label 规则。
- 若桌面端接入 terminal 主题选择 UI，只要界面显示“Active/正在使用”，点击动作就必须立即持久化到 shared `BridgeSettings.terminalThemeId`；不能只改本页 draft，避免出现“看起来切了主题，切页后又回默认”的假激活。

### 2.2 连接 / tmux
- remote 连接与 local tmux 都必须走真实 runtime，不允许静态占位冒充 live terminal。
- “能列 session” 不等于 “已 attach”；需要真实 connect / attach / resize / input 路径验证。
- 修改 local tmux / remote bridge / renderer 任一层后，必须至少做一次实际 smoke，不只看编译通过。
- Electron local tmux head/sync 的 canonical capture 必须包含 scrollback + visible pane bottom；`capture-pane -E -1` 会停在历史尾部，不能用于 app buffer truth，否则 packaged DOM 会落后真实 `tmux capture-pane` 尾部。

### 2.3 资源与生命周期
- 不允许只凭代码阅读宣称“没有内存泄漏/没有孤儿进程”；必须有运行态证据。
- 旧 app 必须先退出，再打开新包；不要叠多个实例污染结论。
- 禁止 broad kill；退出旧 app 用应用级 quit 或明确 PID 级关闭。
- tmux / daemon / CDP smoke 必须先盘点现有资源，再复用本轮已有专用 session / port / app 实例；禁止每次验证都新建 timestamp session。
- 只有两类 session 允许写入或重置：本轮明确创建的专用 session，或带项目 gate marker 且 owner/case 匹配的固定 gate session。已有用户 session 只允许只读观测。
- 每个 live / blackbox smoke 结束前必须复核生命周期：列出本轮新增 session / pipe-pane / app PID / debug port，关闭临时资源；若固定 gate session 需要保留供复用，必须说明 marker 与名称。
- API / 坐标 / 截图这类探索实验也按同一资源协议执行：优先复用现有 iTerm2 / tmux / daemon 观测资源；必须新建窗口、session、端口、venv、临时目录时，用固定 marker 或可追踪 run id 标识，并在 `finally` / 结束清单中关闭或说明保留理由。禁止只跑完实验不清理测试窗口、临时服务、pipe-pane、debug port。
- iTerm2 Python API pane 坐标进入 daemon/stream 真源时，leaf `frame.x/y` 只保证相对其 immediate splitter；嵌套 split 必须先按 splitter cursor/offset 递归 flatten，再套一次 window top-left + content inset。禁止在度量阶段再次累加已定位 leaf offset；必须用真实复杂 split tree 回归和 live crop bounds gate 锁 `cropRect` 不越过 window。
- Remote window catalog 不能把 target 限死在 tmux 或 iTerm2：generic macOS app-window 走 daemon-side window catalog truth；无 tmux 映射的 iTerm2 pane 仍是 selectable `iterm2-pane`，不能造假 tmux id 或拒绝选择。live gate 至少断言 `nonItermAppWindows >= 1`、`nonTmuxPanes >= 1`、`outOfBounds == 0`。

### 2.4 Desktop workspace owner gate
- Mac desktop workspace / multi-window / pane-tab-runtime / file browser 重构必须先查并同步：
  - `mac/docs/function-map.md`
  - `mac/docs/mainline-call-map.json`
  - `mac/docs/testing/mac-desktop-workspace-test-design.md`
- 未落地 owner 只标 `binding pending`，禁止伪造 symbol / caller / callee。
- 初始架构 gate 只锁当前已成立事实与 map parseability；不要把后续切片才会修的 transitional debt 提前做成误报红测。
- 当实现进入对应切片后，必须把 pending 规则升级为 hard gate，例如 runtime 创建只能在 `MacRuntimeRegistry`，pane UI 不得直接 `connectRemote/connectLocalTmux`。

---

## 三、强制闭环流程（Jason 新冻结）

### 3.1 默认执行顺序
任何 Mac 改动，默认按下面顺序闭环；**没走完，不要向 Jason 报“可以手测”**。

```text
改代码
  -> type-check
  -> build
  -> package（若影响 packaged 行为）
  -> 退出旧 app
  -> 启动新 app / 新包
  -> 自己完成 smoke
  -> 采集证据（命令输出 / 截图 / 资源快照）
  -> 只有证据闭环后，才能汇报 Jason
```

### 3.2 触发 packaged smoke 的场景
出现以下任一项，必须跑 packaged app smoke，而不只 dev server：
- Electron main / preload / IPC 改动
- 本地 tmux 接入改动
- 窗口恢复 / 启动 / 单实例 / app 生命周期改动
- renderer 资源占用 / 退出态 / orphan process / memory leak 排查
- 用户明确说“我要实际使用”“我要重新编译安装”

### 3.3 最低验证门槛
#### A. 静态门槛
```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

#### B. 核心连接门槛
Mac terminal / transport / runtime 改动必须先跑本地客户端核心连接 gate，不能用 daemon-only probe 替代。

```bash
pnpm --dir mac test -- --reporter dot
pnpm --dir mac run type-check
```

最低覆盖面：
- `bridge-transport`：remote daemon WebSocket 两阶段握手、connected state、head/body/input 发到 live socket、stale socket 不污染当前连接。
- `local-tmux-transport`：Electron local tmux API connect、connected event、head/body request、input/resize/activity/disconnect 同一 clientId。
- `terminal-runtime`：head 变化触发 body sync，same-end revision 变化不能被去重吞掉。
- workbench active target：tab/pane 切换不重复 reconnect，不把 local/remote target 混成第二状态机。

证明范围：
- 证明 Mac client transport/runtime 核心连接逻辑可用。
- 不证明 packaged `.app`、真实窗口、DOM 输入、资源/退出态已闭环。

#### C. packaged 门槛（按需）
```bash
pnpm --filter @zterm/mac package
```

#### D. 运行态 smoke 门槛
至少覆盖本轮改动直接影响的主路径：
- terminal 能打开
- input / resize / scroll / split / tab 中与本轮相关的关键路径
- local tmux 或 remote bridge 至少一条真实链路
- terminal buffer/render 正确性必须比较 session truth 和 app render output：
  - session truth：`tmux capture-pane`
  - input oracle：专用 session 的 `tmux pipe-pane`
  - app output：packaged app DOM rendered rows / 截图
  - 必跑 gate：`pnpm --dir mac run blackbox:terminal-buffer -- --case=all`
  - 必须包含持续刷新底部 TUI case；只看到 `connected`、底部几何对齐或静态截图不算 terminal 数据闭环
  - blackbox gate 必须复用固定专用 tmux session：`zterm_mac_gate_sequence` / `zterm_mac_gate_tui` / `zterm_mac_gate_large`，并用 tmux option marker 验证 owner/case 后才允许 respawn / clear-history / cleanup；禁止 timestamp 新建一串 session，禁止碰无 marker 的用户 session
  - packaged app 启动必须先 ad-hoc 重签 bundle，再带显式 `--user-data-dir` 直接启动二进制；禁止 `open -n` unsigned package（Launch Services 会在第二次或之后把 unsigned bundle 重新走 Gatekeeper，常见“恶意软件/移到废纸篓”回归）。正确顺序见 §3.6 Packaged App 启动协议。
  - blackbox gate 默认保留这三个固定 session 作为复用池；只有显式 `--cleanup-sessions` 才能在 marker 验证通过后精确关闭它们。运行结束必须复核 `tmux list-sessions`，确认没有遗留新的 `zterm_mac_*` 临时 session
  - TUI fixture 每次 run 前必须重置内容和清 history；持续刷新只比较当前可见 screen 与 app rendered rows，历史/overscan 只能作为 raw evidence，不能进入 lag 判定
  - large-reading fixture 必须证明真实 scroll 容器进入 reading：`scroll.atBottom=false`、append 后 reading rows 不变、scroll-to-bottom 后 app tail 与 tmux tail 一致；若 `clientHeight === scrollHeight`，先修父容器高度约束，不准把 DOM 全量内容当作 reading 通过
- 若改的是资源/生命周期：补 `ps/top` 资源采样 + 退出态进程检查

#### E. 证据门槛
证据至少二选二：
- 命令输出
- app 截图
- 进程 / RSS / CPU 快照
- 必要时日志 / sample

证据落点：
- `mac/evidence/<date>-<topic>/`

---

## 四、资源/泄漏专项闭环

### 4.1 资源审计最低动作
```bash
ps -axo pid,ppid,pgid,%cpu,rss,vsz,etime,comm | egrep 'PID|ZTerm|Electron Helper'
top -pid <renderer_pid> -stats pid,cpu,mem,threads,state,time -l 2
```

### 4.2 退出态检查
- 先退出旧实例
- 确认旧 PID 消失
- 再启动新实例
- 不允许跳过这一步就汇报“没有孤儿进程”

### 4.3 报告规则
- 先给证据，再给结论
- 若只完成编译、未完成运行态 smoke，只能报告“代码已编译，通过静态验证，未完成运行态闭环”
- 若只完成 dev server、未完成 packaged smoke，不能向 Jason 说“可安装使用”

---

## 五、反模式
- 编译过了就让 Jason 手测
- daemon/tmux probe 绿了就宣称 Mac client 连接正常
- Mac client core tests 绿了就宣称 packaged `.app` 正常
- 只在浏览器里验证，却汇报 packaged app 可用
- 没退出旧 app 就直接打开新 app
- 没有运行态证据就下“无泄漏 / 无 orphan / 性能已优化”结论
- 让 Jason 帮忙补你本该先完成的基础 smoke

---

## 六、完成态汇报模板
只在闭环完成后使用：

```text
Jason，已完成本轮自闭环：
1. 改动：
2. 静态验证：type-check/build/package 结果
3. 运行态 smoke：做了哪些真实操作
4. 证据：截图/命令输出/资源采样位置
5. 结论：哪些已验证通过，哪些仍未覆盖
6. 现在才轮到你手测的部分：
```

### 3.4 本地 package 签名授权规则
- 本地 `pnpm --filter @zterm/mac package` 必须默认跳过 macOS code signing：`CSC_IDENTITY_AUTO_DISCOVERY=false` + `build.mac.identity=null`。
- 禁止让 `electron-builder` 自动发现 distribution identity；否则每次 package 都可能触发 Keychain 授权弹窗。
- 只有正式发布/分发签名任务才允许显式启用签名 identity，并必须单独说明签名和 notarization 验证。
- 本机安装 unsigned package 前，先对 `.app` 做 ad-hoc 重签：`codesign --force --deep --sign - <ZTerm.app>`，再复制到实际目标路径并对目标再签一次。目标路径必须从运行中进程或 Jason 实际点击入口确认，优先检查 `/Applications/ZTerm.app`、`$HOME/Applications/ZTerm.app`、`~/Downloads`、`~/Desktop`、`~/.Trash`；不要只修 `/Applications` 后宣称完成。
- 不要使用 `xattr -cr` 处理 `.app` bundle；它可能生成 `._*` AppleDouble 文件并破坏 sealed resources。若误生成，只能在该 `.app` 内精确删除 `._*` 后重新签名。可精确删除 `com.apple.quarantine`；不要把 `spctl --assess rejected` 当作 unsigned internal alpha 的启动失败证据，真实判定必须用 Finder/open 启动和进程路径。
- 若 Finder 提示“恶意软件并移到废纸篓”，先查实际入口包的 `codesign --verify --deep --strict` 与 `spctl --assess --type execute --verbose=4`。若输出 `notarization indicates this code has been revoked`，根因是旧 revoked 包仍在实际路径，必须退出该路径的运行中明确 PID、把旧包改名备份、安装当前构建、重签、再从同一路径启动验证；`osascript tell application "ZTerm" to quit` 可能被 revoked app 挂住，卡住时只结束该明确 `osascript` PID，再用旧 ZTerm 明确 PID 关闭。

### 3.6 Packaged App 启动协议（2026-08-27 冻结）

Unsigned 本地 package 启动必须严格按下列顺序，禁止改换步骤顺序。

1. **断言 bundle 存在**：`<workspace>/mac/out/mac-arm64/ZTerm.app/Contents/MacOS/ZTerm` 必须存在；缺失则直接失败并提示先跑 `pnpm --dir mac run package`。
2. **ad-hoc 重签 bundle 一次**（每次启动前都重签，避免上次遗留 attribute 被 Launch Services 缓存）：
   ```bash
   codesign --force --deep --sign - "$APP_PATH"
   ```
3. **删除 quarantine xattr**（仅作用于本 bundle，绝不 `xattr -cr`）：
   ```bash
   xattr -d com.apple.quarantine "$APP_PATH"
   ```
4. **用 `--user-data-dir` 直接执行二进制**，绝对不要 `open -n` unsigned package：
   ```bash
   "$APP_PATH/Contents/MacOS/ZTerm" \
     --remote-debugging-port=<port> \
     --user-data-dir="$EVIDENCE/user-data" \
     --no-sandbox \
     > "$EVIDENCE/launch-stdout.txt" 2> "$EVIDENCE/launch-stderr.txt" &
   ```
5. **必须捕获子进程 exit/stderr/stdout** 写入 evidence。gate 启动后立刻 `tail -f` stderr 不能阻挡主循环；用 `child.on('exit', ...)` / `child.on('error', ...)` + `spawn`（不是 `spawnSync`），把 exit code、stderr 写到 `${EVIDENCE}/launch-exit.json` / `launch-stderr.txt`。
6. **强规则**：
   - 禁止 `open -n <unsigned.app>` 启动 unsigned package；这是 Launch Services 重走 Gatekeeper 的常见触发。
   - 禁止 `xattr -cr <unsigned.app>`；会生成 `._*` AppleDouble 破坏 sealed resources。
   - 禁止把 `spctl --assess rejected` 当作 unsigned internal alpha 的启动失败证据。真实判定必须看 Finder/open 启动 + 进程路径 + CDP `/json/version` + `/json/list` 返回目标 page target。
   - 重签后必须 `codesign --verify --deep --strict` 立即确认 `valid on disk`。
7. **重复启动前必须清理旧进程**：先 `ps -axo pid,comm,args | egrep 'ZTerm|remote-debugging-port=<port>'`，再按 PID kill；禁止叠多个 instance 污染端口和 evidence。

### 3.5 状态 / Alpha 汇报对账门禁
- 触发：Jason 问“今天完成了什么”“Mac 版本状态”“离 alpha 多远”“能不能手测/alpha 测试”，或上下文压缩/恢复后需要汇报 Mac 进度。
- 汇报前必须对账：
  - `git log --oneline -- mac packages/shared .agents/skills/zterm-mac-dev`
  - `git status --short`
  - `mac/MEMORY.md`
  - `mac/task.md`
  - `mac/docs/function-map.md`
  - `mac/docs/testing/mac-desktop-workspace-test-design.md`
  - `mac/docs/alpha-readiness.md`（若不存在或过期，先补齐）
  - `mac/evidence/<date>-*` 证据目录索引
- 汇报必须按证据层级拆开：已提交代码、白盒测试、packaged smoke、真实 daemon/local tmux/live UI、未验证缺口。
- 不得只根据最近 handoff、loop run、Android note 或当前聊天上下文汇报 Mac 状态；Mac 进度以 Mac docs/MEMORY/task/evidence/git 提交共同对账为准。
- 如果发现 evidence 仍是 untracked，只能报告 retention/cleanup 待决策；未经授权不得删除、移动、stage 或提交。

## 六、Mac dev runtime 单实例验证规则（2026-06-02）
- 调试 Electron dev app 时，同一轮只能保留一个 `--remote-debugging-port` 实例；新开前先用明确 PID/app-level quit 收掉旧实例，禁止多端口并发导致证据串线。
- 截图/DOM probe/输入验证必须指向同一个 CDP target、同一个 tmux session、同一个 evidence JSON；不得在多个 Electron 窗口之间交叉取证。
- 临时 CDP probe 不要往页面注入会持久影响事件链的监听器/异常代码；若注入失败导致 renderer error，必须 reload 或重启唯一实例后再验证。
- local tmux 颜色真源是 `tmux capture-pane -e` 的 SGR 输出；纯 `capture-pane -p` 只保留文本，会把 `fg/bg` 全部退成默认色。
- local tmux 数据真源还必须覆盖 visible pane bottom：`LocalTmuxManager` 的 head/sync capture 保留 `-e -p`，但禁止加 `-E -1`；若黑盒出现 tmux/pipe 有完整尾部而 app DOM 缺尾部，先查该 capture 参数，不要在 renderer 补偿。
- local tmux TUI/alternate-screen 类刷新不得走 full-history live payload；`readSessionCapture` 检测 `alternate_on` 后只用 bounded visible capture（`-S -<paneRows>`）作为当前 screen truth，避免历史帧累计成刷新延迟或旧行上移。
- Packaged multi-window smoke 不依赖 `System Events` 注入快捷键作为真源；优先通过正式 preload IPC / menu owner 触发 `MacWindowManager.createWindow()`，再用 CDP 验证 page target、renderer `windowId`、workspace key、quit/reopen restore。若 `System Events` 卡住，只中断该明确 osascript 会话，不能用它证明失败或成功。
- Packaged app 实际使用 `preload.cts -> preload.cjs`。凡修改 `window.ztermMac` bridge 或 IPC surface，必须同步更新 `preload.ts` 与 `preload.cts`，并用 packaged smoke 证明真实 preload bridge 可用；不能只看 renderer type 或 `preload.ts`。
- Packaged React 表单/controlled input smoke 不把直接 `input.value = ...` 当真源；自动化应先 focus/select 目标 input，再用 CDP `Input.insertText` 或等价真实输入路径触发 React state，最后点击正式 UI command。直接 setter 只可作诊断，不能作为 browse/connect/save 成功证据。
- Packaged QuickConnect/session discovery smoke 必须走真实 UI input path 和真实 daemon `list-sessions` 路径：focus/select input 后用 `Input.insertText` 输入 host/port/token，点击正式 Discover / Save & connect；证明 discovery 不创建 runtime，Save & connect 才创建 remote runtime；只允许 dedicated marked tmux session；写入 evidence 前必须 redacted `authToken` / `targetAuthToken` / storage token 字段。
- Packaged CDP smoke helper 必须在 websocket `close/error` 时 reject pending command，尤其是 `Browser.close`；否则数据对比已绿也会因为未 settle 的 top-level await 退出 13，并且缺少 `process-after-close` evidence。
- Packaged runtime A/B input isolation smoke 优先用本轮专用 tmux session + `tmux pipe-pane -o <log>` 作为输入 oracle；`capture-pane` 对 detached `cat` fixture 可能不稳定，不能单独证明 app input 到达或串线。完成后用 `tmux pipe-pane -t <session>` 关闭观测管道，避免后台持续写日志。
- Runtime split/tab smoke 中，resize 必须同时看 DOM pane width 和 workspace record pane size；只看拖拽动作或 divider 存在不算 resize 闭环。关闭 active pane 后必须证明 renderer root 仍 mounted、workspace `activePaneId` 指向现存 pane、剩余 runtime 还能输入。
- Server rail remote refresh smoke 是 read-only daemon observation：只能发 `list-sessions`/Refresh，允许用现有用户 sessions 做列表观测，但禁止写 input、create、kill、rename。证据必须同时证明 refresh 后 live sessions 进入 rail、workspace pane/tab 数不变、terminal stage 未自动打开 session、错误时显示 error 且 saved/open sessions 保留。
- Server rail remote open packaged smoke 必须分两阶段证明：Refresh 后只更新 live projection 且 `runtimeEnsureCalls=0`，explicit rail session click 后才创建 remote runtime 并渲染 dedicated marked session 输出。只能使用本轮 dedicated marked session，evidence/storage 里的 `authToken` / `targetAuthToken` 必须 redacted，结束时复核 debug port、ZTerm/Electron helper、tmux session 已精确清理。
- Disconnect/reconnect packaged smoke 必须诱发 transport owner close/error，不能用 UI Disconnect 冒充断线。local smoke-only forced close 只能挂在 `--zterm-alpha-smoke` 下，证据必须同时证明 active runtime `error -> Reconnect -> connected`、hidden runtime connect count 为 `0`、`windowId` 稳定、`process-after-close*` 为空或有明确解释。
- Legacy workspace cleanup closeout 不能只扫入口 import。必须同时证明旧 all-in-one source 文件物理不存在、生产源码无 `ShellWorkspace` 引用、architecture truth gate 锁 `MAC-16-LegacyRemoval`、packaged DOM 无 `.shell-workspace-root` / forbidden root。历史 `zterm:mac:shell-workspace:v1` localStorage 残留只说明用户数据未清理，不可当作 fallback 存在或已读取的证据。

## 七、单 session 操作铁律（2026-06-02 新增）

### 7.1 禁止向任意 session 写入 input
- **绝对禁止**：`tmux send-keys`、`send-text` 到任何不在本次测试范围内的 tmux session
- **绝对禁止**：用 IPC / CDP / AppleScript 向非目标 window/pane 注入按键
- **原因**：会污染用户真实工作 session（如 `fin`、`rcc`、`server` 等已有 session）
- **触发场景**：任何 input echo 验证、按键注入测试、session 列表遍历
- **正确做法**：只操作本次 smoke 专用 session（如 `zterm_mac_color`），不碰其他 session
- **验证方式**：`tmux capture-pane -p -t <session>` 确认只含测试内容，无污染
