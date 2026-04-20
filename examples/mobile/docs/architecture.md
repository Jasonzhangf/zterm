# wterm-mobile Architecture

## 真源层级

1. `spec.md`：产品范围
2. `architecture.md`：模块边界
3. `dev-workflow.md`：执行门禁
4. `task.md`：当前任务
5. `CACHE.md`：短期上下文
6. `MEMORY.md`：长期经验
7. `evidence/`：运行证据
8. `SKILL.md`：可复用规则

## 模块边界

- UI/App：页面、表单、列表、终端布局
- Storage：主机配置与运行态持久化
- Session/Transport：WebSocket、tmux bridge 会话状态
- Android Shell：Capacitor、通知、后台服务
- Server：本地 Mac/PC 上的 tmux → WebSocket 桥接
- Server daemon 启动入口：`scripts/wterm-mobile-daemon.sh`

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
- Server 只管本地 tmux 真源

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

## Terminal viewport / buffer 规则

- client 不负责 buffer 重排；client 只负责测量当前 viewport / font metrics，并把 `cols / rows` 同步给 daemon
- daemon / tmux 是 shell 排版真源；同一个 session 的当前宽高以 daemon 当前收到的 viewport 为准
- keyboard show/hide、pinch zoom、orientation change、container resize 都属于 viewport 变化，不属于 buffer 刷新
- viewport 变化时只允许：
  1. 更新 terminal 可见高度
  2. 重新计算 `cols / rows`
  3. 同步给 daemon / tmux
  4. 用新的 viewport 继续渲染当前 buffer
- viewport 变化时不允许：
  - clear terminal
  - replay `outputHistory`
  - 重建 session
  - 本地重排旧 buffer 作为真相
- reconnect / cold resume 才允许从 daemon 重新拿 snapshot；keyboard 显隐只做 layout refresh

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
examples/mobile/
├── src/          # 源码
├── docs/         # 规范与流程
├── scripts/      # build / install / verify 脚手架
├── task.md       # 当前任务板
├── CACHE.md      # 短期记忆
├── MEMORY.md     # 长期记忆
├── evidence/     # 验证证据
├── android/      # Capacitor Android 项目
└── dist/         # 构建产物
```

## 代码 ownership 入口

页面级切片和未来文件 ownership 统一见：

- `docs/ui-slices.md`
