# MEMORY — Mac Long-Term Memory

## Key Decisions

- [2026-04-20] Mac 第一阶段先做 Electron 最小可执行包，优先证明 build/package/window/stage 闭环，再逐步接业务能力
- [2026-04-20] Mac 布局必须遵守仓库统一真源：默认一行多列、列与列之间垂直分屏、不以上下堆叠多 pane 为主方案

## Patterns

- 先证明 `.app` 能构建和启动，再谈共享 page/component 复用，能降低桌面壳不确定性
- Electron 打包时 `main` 路径必须和 `tsc` 输出目录一致；Vite 的 `base` 需要设为 `./`，否则 file:// 打开时资源路径会失真，窗口会出现空白或 chrome-error 页面
- shared layout 真源已落到 `packages/shared/`：先把 profile resolver 和 PaneStage 放到共享层，再让 Mac 页面槽位消费它，能避免 page-local breakpoint 回流成第二真源
- [2026-04-20] Android 连接配置流移植到 Mac 时，先抽 shared `connection/* + react/*` 真源，再让 Mac 的 Connections / Details / Terminal 消费；这样能保证 host/bridge/session 语义和 Android 一致
- [2026-04-20] Electron `.app` 适合验证 package/window/stage 是否可执行；表单交互与回显验证更稳定的入口是浏览器 dev server（同一 renderer），验证完再回到 `.app` 确认桌面壳不回归
- [2026-04-20] `Detected Tmux Sessions` 只能证明 bridge 上能列 tmux session，不能证明 session 已 attach；Mac live connect 必须额外发送 `connect + stream-mode(active)`，否则会表现成“能看到 session，但无法连接”
- [2026-04-20] Mac live terminal 真源应保持 app-level：Details 只发 connect request，socket / heartbeat / buffer / active target 统一收口到 `useBridgeTerminalSession()`，Terminal 只消费 shared renderer
- [2026-04-20] 若 `bridgeHost` 已写成 `ws://host:port`，display / remembered server preset / stored effective port 都必须以显式 URL 为真源；否则 UI 会出现 `ws://127.0.0.1:4333:3334333` 这类双端口假象
- [2026-04-20] 桌面验证若需要重开 packaged `ZTerm.app`，必须先 quit 旧实例，再 open 新包；不要直接叠多个实例，否则很容易把旧窗口缓存误判成“新包没更新”
- [2026-04-20] packaged `.app` 做 live connect smoke 时，先把窗口切到 `wide-3col` 让 Details pane 常驻，再在同一实例里直接改 host/token 并点 Connect；这样能避免 2-col 下依赖 Edit 切 pane 造成验证噪音
- [2026-04-20] Mac Details 表单若手动输入显式 `ws://host:port`，应立刻把 `bridgePort` 同步到同一个端口；否则虽然底层 URL 真相已正确，表单仍会误导用户
