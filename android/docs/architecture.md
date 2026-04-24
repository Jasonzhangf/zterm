# zterm Android Architecture

## 真源层级

1. `spec.md`：产品范围
2. `architecture.md`：模块边界
3. `docs/decisions/0001-cross-platform-layout-profile.md`：跨尺寸布局 / Mac 共享壳决策
4. `docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`：terminal head / sparse buffer / render container 唯一真源
5. `docs/decisions/2026-04-22-session-schedule-timed-send.md`：per-session 定时发送 / heartbeat 调度真源
6. `dev-workflow.md`：执行门禁
7. `task.md`：当前任务
8. `CACHE.md`：短期上下文
9. `MEMORY.md`：长期经验
10. `evidence/`：运行证据
11. `.agents/skills/terminal-buffer-truth/SKILL.md`：terminal buffer / render / scroll 真源规则

## 模块边界

- UI/App：页面、表单、列表、终端布局
- Layout/Presentation Shell：layout profile、pane 编排、safe-area / density token
- Storage：主机配置与运行态持久化
- Session/Transport：WebSocket、tmux bridge 会话状态
- Schedule/Automation：per-session 定时任务定义、下次触发时间计算、启停与结果状态
- Client Mirror Buffer：只按绝对行号合并 daemon canonical buffer
- Client Render Window：唯一状态是 `renderBottomIndex`；`renderTopIndex` 只能由 `renderBottomIndex - viewportRows` 派生，不得成为第二真源
- Android Shell：Capacitor、通知、后台服务
- Server：本地 Mac/PC 上的 tmux → WebSocket 桥接；维护 canonical buffer 与 per-session 调度真源
- Server daemon 启动入口：`scripts/zterm-daemon.sh`

## 跨尺寸布局真源

- 唯一设计决策文档：`docs/decisions/0001-cross-platform-layout-profile.md`
- 跨尺寸布局必须由单一 layout resolver 输出 profile；page component 不得各自散落 breakpoint 真源
- 可复用单元是 **phone-sized pane**，不是“Android 页面”和“Mac 页面”各做一份
- foldable / pad / split-screen / future Mac 默认采用**一行多列 + 垂直分屏**；只改变列数、列宽和默认展开方式，不改变 `Connections / Connection Properties / Terminal` 的语义
- future Mac 复用 app-layer 页面、会话、存储和 layout policy；平台壳只补窗口、菜单、快捷键、拖拽、原生输入等能力

## UI 信息架构

### Screen 1: Connections

- 顶部标题区：`Sessions` / `Connections`
- 工具栏区：关闭、标题、账户动作、更多
- 列表区：Bookmarks / Sessions / Connections 卡片
- 卡片区：名称、图标、必要时终端预览、进入箭头或主点击区
- 新建入口：右下角浮动按钮
- 底部导航区：可选 `Vaults / Connections / Settings`

### Screen 1A: Session Picker

- `New connection` 先进入 session picker，而不是直接空白表单
- 顶部先选目标 server，或手动输入 Tailscale IP / tailnet 域名
- server 输入后不自动探测；必须由用户显式点击 `Connect / Refresh`
- 列表顺序：历史连接优先、当前 tmux sessions 次之、最后才是 clean session/custom form
- tmux 列表支持 create / rename / kill / multi-select
- Terminal 顶部 `+` 长按也复用同一个 picker，直接用于 quick new tab
- 选中多个 tmux session 后可一次直接打开多个 tabs

### Screen 1B: Connection Properties

- 顶部栏：关闭 / 返回、标题
- 表单区：纵向 section 列表
- section 顺序：
  - General
  - Tmux Session
  - Connection
  - Terminal
  - Appearance
- 所有字段在手机安全区内可滚动编辑

### Screen 2: Terminal

- 顶部连接栏：返回、当前连接胶囊、加号新建
- 中部终端区：终端输出主画布
- 底部快捷栏：方向键、回车、键盘切换、图片按钮
- 悬浮球快捷菜单：点击展开文本快捷输入列表，支持直接注入保存好的字符串、+添加、排序、编辑修改
- 扩展输入层：ESC/TAB/CTRL/ALT/符号/编辑/更多/命令输入条

## UI ownership

- Layout shell 负责单行多列编排、垂直分屏与 profile 到页面槽位的映射
- `Connections` 页负责连接入口与主机卡片管理
- Host form 负责新增/编辑，不直接承载终端操作
- Connection Properties 页负责连接配置编辑
- Terminal 页负责会话消费，不承载主机配置编辑
- 快捷输入层独立于系统键盘，作为移动端增强输入模块

## 数据流

```text
operation -> event -> projection
```

- operation：用户动作或控制动作
- event：已发生事实
- projection：当前 UI 视图

## 责任划分

- UI 只消费 projection，不补业务真相
- Storage 只管持久化，不管业务决策
- Session/Transport 只管连接与协议转换
- Schedule/Automation 只定义规则、nextFireAt 计算与执行结果，不直接承载 UI 展示
- Server 负责本地 tmux 真源，以及定时发送的唯一执行真源

## 图片传送链路

```text
mobile file picker -> websocket paste-image -> daemon temp file
-> sips normalize to png -> macOS clipboard -> tmux input Ctrl+V
```

规则：

- client 只负责选择本地图像并上传原始字节，不自行裁剪语义
- server 负责解码/格式统一（当前统一转成 PNG）
- 剪贴板真源在本地 Mac/PC daemon，不在 mobile client
- `Ctrl+V` 发送给当前 active tmux 会话，不广播给其他 tabs

## Session schedule / timed send 真源

### Schedule Job

- `targetSessionName`
- `payload.text`
- `payload.appendEnter`
- `rule`
- `enabled`
- `nextFireAt`
- `lastFiredAt`
- `lastResult`
- `lastError`

规则：

- daemon 是定时发送的唯一真源；Android / Mac 只做编辑和展示
- job 绑定 tmux `sessionName`，不能绑定客户端 runtime `sessionId`
- client 不允许再各自起本地 timer 做实际发送
- UI 可以显示 `bridgeHost + bridgePort + sessionName`，但实际执行 target 先以 tmux session 为准
- daemon 重启后不补历史 backlog，只计算未来下一次触发

## Terminal viewport / buffer 规则

- client 不负责 shell 排版；client 只负责：
  1. 连接初始化时上报当前 viewport `cols / rows`
  2. 把 daemon canonical buffer 镜像到本地
  3. 用 daemon 给出的 viewport 底部指针渲染最后一屏
- daemon / tmux 是 shell 排版真源；同一个 session 的 tmux geometry 应按多 client 的**最小 geometry**收敛
- IME / keyboard show/hide 只允许改变 render container 位置，不属于 tmux geometry change
- pinch zoom / orientation / real container resize 才属于 geometry 变化候选
- viewport 变化时不允许：
  - clear terminal
  - replay `outputHistory`
  - 重建 session
  - 本地重排旧 buffer 作为真相
  - 因 IME 动画而持续修改 tmux 高度

## Terminal canonical buffer ownership

```text
tmux truth
    ↓
daemon tmux mirror
    ├─ canonical line buffer (唯一真源)
    ├─ canonical cursor/view bottom
    └─ zterm clients min(cols, rows) -> tmux resize
                ↓
      client mirror buffer (absolute-indexed)
                ↓
renderBottomIndex (唯一渲染锚点)
renderTopIndex = renderBottomIndex - localViewportRows
render window = [renderTopIndex, renderBottomIndex)
                ↓
      render container position only
```

规则：

- daemon 是 tmux 的 mirror，不是 input relay，不是本地 pty output projection
- daemon 只做两件事：1) mirror tmux truth；2) 按 zterm 已连接 client 的最小 geometry 通知 tmux resize
- daemon 不改写 tmux 内容语义；它只发送控制（input/attach/resize 等）并读取 tmux truth，不允许在 daemon 侧二次改写/裁剪/重排 tmux 内容来“修显示”
- daemon canonical line buffer 是 terminal 信息的唯一真源；client/debug/local state 都不得成为第二真源
- daemon 的对外职责收敛为：**30Hz head 广播 + range request 响应**；不再主动 push buffer 内容
- cursor 属于 canonical truth，本轮收敛下优先烘焙进 buffer cells，不走 client overlay 第二真源
- client mirror buffer 是 **sparse absolute-index buffer**，允许不连续；只围绕当前工作集补缺
- client active session 本地固定 `33ms` cadence 只做 head freshness / demand 判定；真正的 tail / reading range 拉取频率由网络状况与配置决定，不把“30fps 检查”误做成“30fps 必拉 range”
- `sendInput()` 不做本地回显；若当前是 active session，只挂 `input-tail-refresh` demand，再由本地 cadence 主动发 follow `buffer-sync-request + ping` 去拿 server canonical buffer
- client render 只维护自己的 `renderBottomIndex`；follow 时对齐 daemon bottom，reading 时只改自己的 bottom pointer，top 只做派生计算
- render 不得参与 buffer 生产；它只能声明“当前 bottom-window 命中了哪些行、缺了哪些行”
- reading 滚到当前缓存窗顶部时，3 屏只是 cache window，不是硬上限；client 需要预取上方两屏并展示 loading，再继续向上滚，不允许把顶部硬卡死
- 已经进入 canonical buffer 的历史行视为 immutable fact；resize 只影响之后的新输出，不允许回写/重排旧事实
- geometry 决策只看 zterm 自己的接入端；Termius/iTerm/iSSH 等外部 tmux client 不参与 daemon 的 geometry policy
- 当前优先目标是“正确最后一屏”；reading / scroll 状态机继续以“worker 补当前窗口缺口”实现，不再让 renderer 参与 transport

## Connection / Session 真源

### Host（连接配置）

- `name`
- `bridgeHost`
- `bridgePort`
- `authToken`
- `sessionName`
- `autoCommand`
- 其余 appearance / auth / tags 字段

### Runtime Session（运行态 tab）

- `connectionName`
- `bridgeHost`
- `bridgePort`
- `authToken`
- `sessionName`
- `state`
- `auth state`(derived from target token availability)
- `title`

规则：

- `Host` 是持久化连接配置真源
- `Runtime Session` 是 tab / attach 运行态真源
- 不能再把 `bridgeHost` 和 `sessionName` 混在一个字段里
- UI 上任何“当前连接”展示都必须能恢复为 `server + session` 组合
- Server 进程启动方式也要有唯一入口：本地后台 daemon CLI，监听端口由统一配置决定（当前 `3333`）
- daemon 的 host / port / auth token 真源在 `~/.wterm/config.json -> mobile.daemon`
- client 侧按服务器维度记住 `bridgeHost + bridgePort + authToken`，并在 picker / connection form / reconnect 时复用
- 连通性探测必须显式触发；未填写 token 时禁止自动探测 / 自动重试 tmux 列表
- websocket 会话采用双向保活：client 负责 app-level `ping + pong timeout`，server 负责 ws protocol heartbeat；任一侧失联后都要自动 close 并进入 host 级串行指数回退重连
- `sendInitialSnapshot()` 中任何 `tmux capture-pane` 失败都只能降级为 bridge snapshot；不允许因为初始滚动缓冲获取失败而让 daemon 进程退出

## 当前实现与目标差距

- 当前是“主机列表页 + 顶部按钮”，目标是“Connections 连接中心”
- 当前缺少独立的 Connection Properties 结构页
- 当前终端页的悬浮菜单语义必须是“文本 snippet 注入”，不能再把它和方向键 / Esc 这类快捷键组合混用
- 当前新增主机入口位于状态栏危险区域，目标是安全区内可点
- 当前页面结构偏网页，目标是移动端终端应用结构

## Workspace 约定

```text
android/
├── src/          # 源码
├── docs/         # 规范与流程
├── scripts/      # build / install / verify 脚手架
├── task.md       # 当前任务板
├── CACHE.md      # 短期记忆
├── MEMORY.md     # 长期记忆
├── evidence/     # 验证证据
├── native/android/ # Capacitor Android 项目
└── dist/         # 构建产物
```

## 代码 ownership 入口

页面级切片和未来文件 ownership 统一见：

- `docs/ui-slices.md`
