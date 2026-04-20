# zterm Android Spec

## 目标

做一个 Android 终端应用，通过 Tailscale / 局域网访问本地 Mac/PC 上的 tmux bridge，管理多终端连接与会话。

## 核心能力

- 主机管理：新增、编辑、删除、置顶、最近连接
- tmux 会话：多 Tab、切换、关闭、重连
- 终端渲染：接入 `@jsonstudio/wtermmod-react`
- 移动端增强输入：快捷键条、方向键、键盘切换、必要时命令输入条
- 悬浮球快捷菜单：展开后显示**文本快捷输入**列表，支持点击注入保存好的字符串、+添加、排序、编辑
- 图片传送：从手机本地选择图片，传到本地 daemon，写入服务器剪贴板，并向当前会话发送 `Ctrl+V`
- 后台能力：保活、通知、后续 WebDAV 同步

## 跨尺寸与 Mac 复用原则

- phone / tablet / foldable / split-screen / future Mac 必须共享**同一套布局方法**
- 统一保持 `Connections / Connection Properties / Terminal` 三条页面主线，不因平台改写信息架构
- 大屏优先通过**单行多列的 phone-sized pane 编排**来获得统一效果，列与列之间使用垂直分屏，而不是重做 desktop-only 页面
- future Mac 客户端复用 shared app-layer 的页面、布局 primitives、session/storage 真源；平台差异仅限于 shell 能力
- 唯一设计决策真源为：`docs/decisions/0001-cross-platform-layout-profile.md`

## 连接模型

- 一个连接配置至少显式包含：
  - `bridgeHost`
  - `bridgePort`（默认由统一配置决定，当前为 `3333`）
  - `sessionName`（可空，运行时回退到 connection name）
- 连接配置不能再用单一 `host/username` 混装 bridge server 与 tmux session 语义
- tab / live session / terminal header 必须能区分：
  - 不同 server 上不同 session
  - 同一 server 上不同 session
  - 同一 session 被多个客户端 attach

## 不在范围

- tmux/screen 集成
- Tailscale 客户端集成
- 密钥导入/生成
- 数据加密存储
- 生物识别解锁

## 主路径

### 主路径 A：Connections 入口

1. 打开应用
2. 进入 `Connections`
3. 看到连接中心而不是纯文本列表
4. 看到连接卡片列表 / Session 列表
5. 点击已有连接进入终端

### 主路径 B：新增主机

1. 打开应用
2. 进入 `Connections`
3. 点击新增主机
4. 在 session picker 输入/选择 `bridgeHost + token`
5. 手动点击 `Connect`
6. 选择 tmux session 或进入完整表单
7. 保存主机
8. 看到新连接卡片
9. 点击连接进入终端

### 主路径 C：终端操作

1. 进入终端页
2. 顶部看到当前连接胶囊栏 / Tab
3. 底部看到快捷操作栏
4. 切换系统键盘 / 扩展快捷键盘
5. 点击悬浮球展开快捷输入列表，选择一条保存好的字符串直接注入，或进入编辑修改
6. 发送方向键 / 回车 / 控制键
7. 点击图片按钮，选择本地图像，发到当前会话

## 视觉与交互参考冻结

### 主参考

- 2026-04-18 15:14 两张图：整体导航、终端页结构、Connections 页结构
- 追加参考：Session 列表页、Connection 属性页、终端底部快捷栏、连接预览卡片

### 次参考

- 2026-04-18 10:19 / 10:20 / 14:45 / 14:46 四张图：快捷键条、扩展键盘、命令输入条

### UI 目标

- 终端页采用深色终端主画布
- 顶部采用移动端胶囊式连接栏，而不是网页按钮条
- 底部采用固定快捷操作栏，而不是把按钮堆在页面正文里
- `Connections` 作为连接中心，而不是纯黑底主机列表页
- 主机展示优先使用连接卡片，而不是纯文本列表
- Connection 属性编辑页采用分组表单，而不是一次性平铺字段
- 新建连接入口优先采用右下角浮动按钮，而不是顶到状态栏的按钮

## Connection 结构冻结

### Connections / Sessions 列表页

- 深色背景
- 顶部栏：关闭 / 标题 / 账户动作 / 更多
- 主列表区：Session / Bookmark / Connection 卡片
- 卡片显示：图标、名称、必要时终端预览缩略图
- 新建入口：右下角浮动 `+`

### Connection 卡片

- 优先显示连接名
- 可附带终端预览缩略图
- 连接卡片支持进入终端
- 卡片上的关闭/删除动作应独立于“进入连接”主点击区

### Connection 属性页

- 采用纵向滚动表单
- 按 section 分组，而不是单一长表单：
  - General
  - Tmux Session
  - Connection
  - Terminal
  - Appearance
- 适合手机单手滚动编辑

## 验收标准

- 主机能在 APK 中新增并持久化
- 主机能被连接到本地 tmux bridge 会话
- 真机与浏览器的主路径一致
- 连接配置持久化时必须显式保存 `bridgeHost / bridgePort / sessionName`
- `Connections` 页信息结构与参考图一致：搜索 / 快连 + 卡片列表 + 底部导航
- 终端页信息结构与参考图一致：顶部连接栏 + 终端画布 + 底部快捷栏
- 新增主机入口不能再依赖顶到状态栏的按钮区域
- Connection 编辑页信息结构与参考图一致：分组 section + 纵向滚动
- Connections 列表页新增入口位于安全区内的浮动按钮
- live session/tab/header 中必须能看出当前 `server + session` 组合
- 服务器端必须能通过单一 daemon CLI 在本地后台启动，默认监听端口由统一配置决定（当前为 `3333`）
- 全局 daemon CLI 入口为 `wterm daemon ...`，并支持 `start / stop / restart / status / install-service / uninstall-service / service-status`
- `wterm daemon start / restart / install-service` 必须等待 daemon 端口真正 ready，再回报成功；不能只以 launchd 已加载为准
- websocket bridge 必须做双向保活：client 定时 ping 并校验 pong 超时，server 也要做 ws heartbeat；任一侧丢心跳后都应自动回收并进入重连，不允许死连接长期占住 session
- daemon 初始快照失败时不能崩进程；`capture-pane` 失败只允许降级快照，不允许把整个 bridge 打挂
- daemon 鉴权真源必须落到 `~/.wterm/config.json`；至少支持 `mobile.daemon.authToken`
- client 必须按服务器维度记住鉴权配置：`bridgeHost + bridgePort + authToken`
- 终端快捷栏必须支持图片按钮；选图后 daemon 需把图片解码/转成 PNG 写入本机剪贴板，并给当前 tmux 会话发送 `Ctrl+V`
- Session picker / Connection Properties 必须提供显式 `Connect / Refresh` 按钮，不能在输入 host/token 时自动探测 tmux
- phone / tablet / foldable / split-screen / future Mac 的布局切换必须来自同一 layout profile 方法，不能在每个页面各自分叉 breakpoint
- 大屏下默认使用双列 / 三列的一行多列编排，并通过垂直分屏统一不同 view；每个 pane 继续保持 phone-sized view 的一致效果
