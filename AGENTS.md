# zterm Agent Rules

## Scope
- 本仓库是 **app-level repo**，当前主线是 `android/`
- `../wterm` 是 fork runtime repo；移动端只依赖其发布后的 npm 包，不把 runtime 源码混入本仓库

## Truth Sources
- `android/docs/spec.md`：产品范围与验收
- `android/docs/architecture.md`：模块边界、数据流、ownership
- `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`：terminal server / buffer manager / renderer / UI shell 唯一真源
- `android/docs/dev-workflow.md`：执行顺序、验证门禁、证据要求
- `android/docs/ui-slices.md`：页面级切片与文件 ownership
- `android/docs/daemon-mirror-test-plan.md`：daemon/tmux mirror 本地验证顺序（当前先 TUI `top` / `vim`，再手机）
- `.agents/skills/terminal-buffer-truth/SKILL.md`：terminal buffer/render/daemon mirror 门禁
- `android/task.md`：当前任务板
- `android/CACHE.md`：短期上下文
- `android/MEMORY.md`：长期经验
- `android/evidence/`：截图 / 命令输出 / APK / logcat

## Workspace Layout
- `android/`：当前 Android 客户端
- `mac/`：未来 macOS 客户端骨架
- `win/`：未来 Windows 客户端骨架

## Hard Rules
- 不在本仓库复制或内嵌 runtime 源码
- runtime 问题改 `../wterm`，app 问题改 `zterm`
- 先验证，后结论；无证据不宣称完成
- terminal 链路必须先更新 docs / AGENTS / skill，再补测试，再改代码
- terminal 链路必须保持 `server / buffer manager / renderer / UI shell` 独立，禁止越层漂移
- daemon / buffer manager / renderer 都必须遵守 **读写解耦**：写侧只维护本层真相，读侧只读取当前真相；**请求不得触发上游同步策略**
- daemon 只关心 `tmux -> mirror store`，**不关心也不能关心任何客户端逻辑/状态**；client buffer manager 只关心 `daemon -> local sparse buffer + visible-range gap repair`，**不持有 renderer follow/reading/renderBottomIndex**
- renderer 是唯一可见窗口真相：只负责 `follow / reading / renderBottomIndex / visible range`；有 gap 先画空白，占位后等 buffer patch 按行/区间重刷
- terminal transport/session 也必须解耦：**client session / active tab / foreground-background / viewport / reconnect 心智只属于客户端**；daemon 只允许持有物理 transport、自身 mirror、自身 tmux truth；inactive tab 只停取数，不得关闭客户端 session / transport 真相；foreground/background/tab switch 不得 fresh recreate transport
- daemon/server 禁止持有任何客户端状态机或客户端身份真相：
  - 禁止 `logical client session`
  - 禁止 `clientSessionId` 成为 daemon 内部真源
  - 禁止 `readyTransportId / session transport token / attach-resume state machine`
  - 禁止 `active tab / foreground / background / viewport / width mode / pane` 进入 daemon 真相
  - 若 wire 上暂时存在相关字段，只允许作为**兼容入参/透传字段**，不得在 daemon 内部成为状态 owner
- 多客户端必须以 daemon 无客户端心智为前提：
  - 多个客户端/多个 transport 可以并行订阅同一 tmux mirror
  - daemon 不负责协调哪个客户端 active、不负责客户端去重、不负责客户端恢复策略
  - daemon 只维护 tmux truth、mirror truth、物理连接与基础读写接口
- terminal 宽度模式必须显式区分：
  - `adaptive-phone`
  - `mirror-fixed`
- `mirror-fixed` 下，client viewport / IME / 容器宽度变化**不得**改写 daemon mirror / tmux 宽度；renderer 只能裁切和横向平移
- `mirror-fixed` 下自动关闭左右滑切 tab，避免和横向平移抢同一手势语义
- 不提交大批 evidence / 构建物 / node_modules

## Build Defaults
- 根目录命令应代理到 `android/`
- Android 原生工程路径：`android/native/android`
- npm 依赖真源：发布后的 `@jsonstudio/wtermmod-*`
