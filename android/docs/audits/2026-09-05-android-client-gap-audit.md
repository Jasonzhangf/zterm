# Android 客户端：架构、UI 与开发规则审计

日期：2026-09-05。范围：整体客户端边界抽查、最新目标差距、手机真实 UI、相关 AGENTS/skill/workflow 修复。

## 结论与证据边界

**目标架构未闭环；UI slot 插件化已存在，UI/业务物理解耦未完成。** 优先解决业务生命周期和能力端口，再做终端工具区的视觉与交互收敛。当前首页/设置已有可复用的深色、绿色强调、分组卡片语言，无需另建视觉系统。

本次交付为审计及规则修复，不是 Cordis/连接/缓存迁移或 UI 产品修复。未修改 runtime、版本或设备配置，未安装 APK、发布 OTA、commit/push。架构项为源码证据，真机项只绑定已安装 APK；不将二者冒充同一构建的 source-to-device 证明。

基线：

- 最新远端 main：`b95f82e6`，本次独立工作树 `playground/android-client-audit-20260905`、分支 `audit/android-client-20260905`。下文源码行号以此基线为准。
- 用户原 checkout：`5cbb0b2b`，包含既有 dirty 文件；比 main 多部分 terminal 修改，同时缺少 main 的新 memory/index 与 L3 目标记录。仅只读交叉检查，未带入或覆盖这些改动。
- 最新目标：[2026-09-05-runtime-memory-truth.md](../decisions/2026-09-05-runtime-memory-truth.md)，关联 [分层记忆](../../memory/index.md)。L3 条目标为 unreviewed；本报告依据它引用的用户确认 decision，并逐项核对代码，不以记忆级别充当实现验收。
- 手机 PLZ110：已安装 `0.1.3.2917 / 1100029170`，WebView `347 × 754 CSS px`。ADB 启动既有应用，CDP 读取 DOM、进入设置、返回连接首页；未向终端发送文本或修改设置。
- 平板 TB324ZC：同版本已安装，但 PowerManager 为 `Dozing`、焦点 `NotificationShade`，两次截图全黑。不能归因为应用黑屏，也不能宣称大屏 UI 通过。
- 原 checkout 的 `terminal-physical-boundary-closeout-plan.md` 为候选分支计划，不是本次运行证据；本报告不重复接管 daemon 修复。

## 当前链与目标链

```text
当前生产组合：App -> ClientCompositionRoot -> local PluginHost / ControlCenter
UI slot：PluginHost -> render callback -> React component/controller -> feature runtime/native I/O

目标组合：Cordis（唯一 lifecycle/capability owner）
  -> 固定 transport / session / buffer / renderer service
  -> business plugin（持有操作与 feature lifecycle）
  -> UI plugin（snapshot + typed intent）

正文：daemon -> physical channel -> frame assembly -> sparse buffer
     -> renderer window -> terminal/video DOM -> container/layout -> UI
```

Cordis 不承载 terminal/file/media body。布局状态、编辑草稿、焦点、展开态可以留在 UI；route identity、重试、文件字节、stream lifecycle、持久化成功事实不能由视图构造。

## 架构差距矩阵

严重度是相对本次目标的迁移优先级；不把所有旧差距认定为本次规则 diff 的回归。

| ID | 级别 | 当前证据 / 影响 | 目标 owner 与最小方向 | 必需验收 |
| --- | --- | --- | --- | --- |
| A1 | P1 | `src/App.tsx:1239` 创建本地 host 并绑定组合 root；`packages/kernel/src/cordis/index.ts:3` 明示 Playground。固定服务尚非生产 Cordis lifecycle | composition/plugin lifecycle：按 decision 迁移到一个 Cordis owner，删除旧生产组合链；不再叠加第三个容器 | start/stop/dispose 失败与重复调用、能力拒绝、生产启动链；原 UI slot 和正文语义保持 |
| A2 | P1 | `src/pages/TerminalPage.tsx:690` 直接读 SessionContext attachment 能力；`:779` 用 `any` 消息和 active-session fallback 发文件 wire；`:1333` 附近根据 Relay candidates 构造 route target。页面同时掌握展示、能力查找、发送目的地 | session/connection/feature owner 下沉：页面只拿已解析 target/snapshot 与 typed file intent；禁止缺 session 静默 return | session 切换、无 target、晚到结果、同 endpoint 多 daemon；证明一次 intent、一个 owner、无错投文件 |
| A3 | P1 | `FileBrowserUiPlugin` 仅包一层 `FileTransferSheet`；后者 `:232/:310/:816` 直接 stat、批量落盘、启动上传；UI 卸载与文件业务生命周期交织 | 复用 `client.file_browser` runtime 与 `client.runtime` native storage，将组件内操作状态机分离下沉；UI 只消费进度/错误并发命令 | 关闭/重开 sheet、切 session、取消、断线、错误不可投 complete、双向 hash/字节数与 ACK 有界 |
| A4 | P1 | `RemoteWindowOverlayController.tsx:1610` 直接 startStream，并拥有 handoff、receiver、quality、清理编排。UI plugin wrapper 不隔离其子树业务 | remote-window feature lifecycle 持有真实 stream identity、single-flight 与清理；UI 留浮窗/布局/焦点投影 | 晚到 start/stop/ACK、后台关闭、同 stream 质量更新、真实 decoded frame；不得恢复旧双启动流 |
| A5 | P1 | `AndroidConnectionService.java:917` 显式 `webrtc-not-supported`；TS traversal 仍构造 RTC candidates，物理 route owner 分裂 | `client.connection_service` 按 decision 承担 Android LAN/UDP/Tailscale/Relay 连接、心跳与重连；UI 只发意图 | native/TS 当前差距与目标分开；网络切换、IPv4/IPv6 同一 UDP tier、healthy foreground 不换代、同 channel 恢复 |
| A6 | P1 | shared `connection/mobile-config.ts:4` 默认 1000；`connection/bridge-settings.ts:109/:573` 最大值绑默认并 clamp；`session-buffer-store.ts:31` 空 buffer 也为 1000 | shared config + client buffer：可配 3000 默认，最大值另按契约设计，不直接把 clamp 改成 3000 即称完成 | 默认/自定义、滚动淘汰、稀疏洞、同绝对行可变、reconnect 保留有效缓存 |
| A7 | P1 | `terminal-mirror-runtime.ts:477` 的 forceRevision 发送整个 mirror range；shared `viewport-utils.ts` 的三屏函数仅证明请求规划，不约束 daemon 首发 | daemon writer/store/publisher 保持各自 owner；首发 head/tail 后最多三屏，普通比较约束到最后一屏 | 首连 wire range 实测、同屏 TUI 原地变更、跨屏跳变、旧历史按需请求；不能锁 stable TUI 行 |
| A8 | P1 | `traversal-relay-client.ts:70/:108` 拼接固定 Relay URL；`daemon-config.ts:15` 仍为 JSON。字符串拆分不等于无默认值 | config owner：校验 JSON、原子 TOML、read-back 后淘汰 JSON runtime source；不在 UI 补地址默认值 | 合法/损坏/中断迁移、未配置显式失败、Relay endpoint 生产读取；凭据协议单独设计，不擅自选择 hash 方案 |
| A9 | P1 | `TerminalView.tsx:316` 调用 renderer-window hook，但 `:741/:976/:1038` 等仍编排窗口 transition，DOM 组件物理边界未完整收口 | `client.renderer_window` 持有窗口策略，DOM renderer 只测量/采集用户动作/读 snapshot；复用现有 hook，避免新 manager | 同绝对行 patch、IME relayout 不误进 reading、reading 保持、follow 恢复、拆帧一次 commit |
| A10 | P1 | `plugin-remote-window/*ownership.test.ts` 只检 wrapper/import 字符串；通过不检查 Controller 的 start/stop。file-browser 同类 | 验证 owner 增加业务效果与下游可达边验收；保留 slot 测试但明确证明范围 | 移除业务 port 后显式失败、UI 单独 mount 无 I/O、生命周期注销无资源遗留、真实 flow |

已有有效边界应保留：独立 frame assembly/sparse/render-store 资源、typed slot contracts、已抽取 file throughput runtime，以及 target/channel 的区分。不要为了拆分重新复制实现。源文件很大仅是线索；上述结论依赖具体能力调用，不依赖行数。

## 真实 UI 设计审计

模式：Operate。主要用户任务是连接、阅读/输入终端、切会话、查看资源。保留深色中性表面、绿色主操作、现有图标/组件系统；不引入新 UI 库或装饰性动效。

| ID | 级别 / 证据 | 观察与用户影响 | 最小设计方向 / 验收 |
| --- | --- | --- | --- |
| U1 | P1 / 真机截图+DOM | 终端右侧 `Web` 与 `窗` 48px 浮钮发生约 19px 垂直重叠，窗按钮部分被遮；键盘开启时占据终端与快捷栏交界 | 一个资源入口或由既有 shell layout 协调非重叠位置；保留各业务 intent。窄屏、IME、拖动后所有入口可点且不覆盖当前输入 |
| U2 | P2 / 真机DOM | 终端抽屉/返回高宽约 34px；快捷按钮高 32/34px。低于 Android 常用 48dp 目标，单手密集操作不友好；本报告不据此单独宣称 WCAG 2.1 AA 违规 | 复用 density token 扩大实际触摸盒，视觉可保持紧凑；验证相邻命中区不重叠，键盘下仍保留足够终端区 |
| U3 | P2 / 真机截图 | Home/Settings 平面分组，Terminal QuickBar 多重凸起边框、阴影和粗字；三行 chrome 与 IME 并存时终端正文可见高度明显受压 | 统一到已有 shell tokens，常用操作保留一行，次级操作渐进展开；尊重用户自定义快捷键，不删除命令。比较 IME 前后正文可用高度 |
| U4 | P2 / 真机截图+DOM | `CURRENT`、`Auto`、`Adaptive Phone`、`Mirror Fixed` 与中文混排；宽度说明含源码标记、tmux/daemon/cols；更新区直接展示 versionCode 与构建时间 | 中文用户任务文案，例如“当前”“自动”“适应屏宽”“保持远端宽度”；技术标识收进高级说明，保留协议值。保存/错误/更新状态仍真实 |
| U5 | P2 / 真机截图 | 347px 首页只有少量卡片可见，active session 主副标题均被截断；大徽标和 route chips 分走身份阅读空间 | 保留连接分组，缩减重复装饰和 route 文案，将识别信息优先；长按/详情提供完整名称。不能只按视觉截断推断选错主机 |
| U6 | P1 / 定向测试 | 2 个 accessibility 文件共 4 条失败：英文 `/configure servers/i`、`/back to connections/i`、`/^save$/i` 和空态英文断言与中文输出冲突 | 测试 owner 按产品中文可访问名更新，并实际验证 label、focus、live region；不把改选择器后绿等同 TalkBack 通过 |

证据目录：`android/evidence/client-audit-20260905/`（本地、Git ignored）：

- `phone-terminal.png` + `terminal-dom.json`：终端、键盘、浮钮和按钮尺寸。
- `phone-settings.png` + `settings-dom.json`：设置导航、混合文案、控件密度。
- `phone-home.png` + `home-dom.json`：返回 Home 后连接入口、active session、长名称。
- `tablet-terminal.png` / `tablet-awake.png`：全黑环境证据，不是产品缺陷证明。
- `ownership-tests.log`：6 文件 17 测试，4 文件通过；2 文件失败，13 tests passed / 4 failed。四个 ownership 文件全部通过，只证明其各自静态边界。

未覆盖：TalkBack、实测对比度、浅色主题、大屏解锁后的 UI、远程窗口实际视频页、弱网/错误态交互、文件实际传输。未为审计修改账号、关闭会话或向现有 terminal 输入。UI 产品验收不能标 PASS。

## 规则审计与本次修复

本次方法对应架构：开发指令/验收文档 owner；类型为旧规则物理替换和唯一入口引用。允许 `AGENTS.md`、两份 Android 相关 skill、architecture/dev-workflow/ui-slices 及本报告；禁止 runtime/native/shared 实现、生成治理产物、版本/部署配置、他人 dirty。无产品代码变化，因此无红测、APK/OTA 要求；验证为 diff/link/skill schema/真实命令核对与 AGY review。

| 冲突 | 修复 |
| --- | --- |
| main 新记忆仅塞进 skill description，原分支缺整个 index | description 改为任务触发，正文提供真实相对链接；AGENTS/architecture 加 current-vs-target 阅读路径 |
| v2 implemented 被误解为 Cordis/业务解耦完成 | architecture/AGENTS/skill 明确切片状态与最新目标的证据区别 |
| `只复用，只扩展` 与消融冲突 | 改为删除/复用/直接实现的最小方案 |
| 协作辅助缺失也被判治理阻断 | 限定必需质量门禁与实际共享写入边界 |
| 所有探索必须写共享 note、每轮强制升记忆 | 改为任务独占记录、单 owner 汇总、明确授权后持久化 |
| 旧 route order 与目标顺序同 skill 并存 | Home/drawer 旧顺序删除，回指最新 decision 与当前差距 |
| 旧 Home account-only/group 管理与 server 直接进入冲突 | 删除三段旧入口规则，回归 Home 产品契约 |
| 双 preview/focus startup、2Mbps preset 与最新单 stream/profile 冲突 | 删除旧双启动验收与固定 preset，保持实际 started stream 身份 |
| 所有 reconnect 都走浮窗与中性 status strip 冲突 | 普通恢复进入既有 strip，仅 offline/typed error 进入固定 banner |
| mirror-fixed 无条件关闭 swipe 与无 pan 时保留出口冲突 | 按手势实际 owner 判定，不按模式名无条件禁用 |
| Node 执行 Python / 漏 rollback / 旧 updates 路径 | 唯一构建脚本真实流程：Gradle normal+rollback、两 APK prepare、verify；明确会写本地 OTA，发布需已有授权 |
| UI slices 把早期 HostList/HostForm 状态称“当前” | 标为历史背景，新增当前页面/slot 入口；去掉固定 Relay 目标 |

未将 1500 行 mobile skill 一次性重写或复制到另一份“新真源”；保留仍有效的细分门禁。它仍有历史定位材料，后续随相关功能迁移按 owner 收敛，不能照历史经验恢复已被决策淘汰的路径。Mac/Windows skill 未改，不在本次 Android 规则修复范围。

## 建议执行顺序与结束信号

1. **规则与基线**：本次补丁先独立 review；整合时保留原分支既有网络拓扑/Auth 更新，不整文件覆盖。统一到包含新 memory/decision 的 main。
2. **UI/业务边界**：优先 TerminalPage route/file dispatch、FileTransferSheet I/O、remote-window lifecycle。每个切片先登记现有 owner/edge，再搬真实状态机；用 typed snapshot/intent 接 UI，禁止只抽文件名。
3. **目标迁移**：固定 service ports 明确后迁移 Cordis 并移除旧生产组合；Android Service 路由、缓存/首发、TOML 各独立切片，按 A1–A9 的验收闭环。认证协议保留独立设计入口。
4. **UI 收敛**：先修浮钮碰撞与操作区密度，再统一中文、身份可读性；不把业务规则搬回 UI。修 U6 后跑真实 TalkBack/手机/平板、IME 开关和错误态。
5. **产品交付**：相关 runtime 修改完成后再跑 registry/type/build、真实 daemon/device 主链与 review；获授权交付时构建 APK、验证安装态与 OTA，并取得独立 Git 交付证据。

结束信号：A1–A10 按 owner 有对应运行证据、U1/U6 关闭且其余 UI 项有明确接受结果、适用设备路径通过。本文存在或静态 tests 通过均不代表这些目标已实现。
