# zterm Android

zterm 的 Android 客户端，基于 Capacitor + @jsonstudio/wtermmod-react。

## 当前真源

- `docs/spec.md`：做什么，不做什么
- `docs/architecture.md`：模块边界与数据流
- `docs/decisions/0001-cross-platform-layout-profile.md`：跨尺寸布局与 Mac 共享壳的唯一设计决策
- `docs/dev-workflow.md`：怎么开发、怎么验收
- `docs/ui-slices.md`：页面级切片与文件 ownership
- `docs/decisions/`：关键决策冻结点
- `task.md`：当前任务板
- `CACHE.md`：本轮短期上下文
- `MEMORY.md`：长期项目经验
- `evidence/`：本地截图、日志、安装态证据（默认不进 Git，仅保留目录说明）
- `scripts/`：构建 / 安装 / 验证脚手架
- `note.md`：agent 自己看的工作笔记，不是项目主真源

## 快速开始

```bash
# 可选：先在 ~/.wterm/config.json 配 daemon 鉴权
pnpm --filter @zterm/android dev
pnpm --filter @zterm/android type-check
pnpm --filter @zterm/android build
cd android && npx cap sync android
```

`dev` 使用 portless，访问命令输出里的 `*.localhost` 地址，不写死端口。

### daemon 鉴权真源

本地 daemon 默认从 `~/.wterm/config.json` 读取 host / port / auth token：

```json
{
  "zterm": {
    "android": {
      "daemon": {
      "host": "0.0.0.0",
      "port": 3333,
      "authToken": "replace-with-your-token",
      "terminalCacheLines": 1000
      }
    }
  }
}
```

客户端会按服务器维度记住 `host + port + authToken`，下次在 session picker / connection form 里自动回填。

运行时文件也统一收敛到 `~/.wterm/`：

- `~/.wterm/config.json`
- `~/.wterm/logs/`
- `~/.wterm/uploads/`

全局安装 daemon CLI：

```bash
pnpm --filter @zterm/android daemon:install-global
wterm daemon restart
# 或
wterm daemon status
```

## 当前终端增强能力

- 快捷栏支持方向键、Esc、Tab、Backspace、系统键盘切换
- 终端支持悬浮球快捷菜单：展开后显示**文本快捷输入**列表，可直接注入保存好的字符串，也可进入编辑器新增 / 排序 / 修改
- 快捷栏支持**图片按钮**：从手机选择本地图片后，通过 WebSocket 发送到本地 daemon
- daemon 会先把图片**统一转成 PNG**，写入 macOS 系统剪贴板，再向当前 tmux 会话发送 `Ctrl+V`
- Session picker / Connection Properties 改为**显式 Connect** 流程：填写 `host + token` 后手动点击 Connect / Refresh，不再自动探测 / 自动刷新
- `wterm daemon start|restart|install-service` 会等待 3333 端口真正监听后再返回，避免“服务刚启动但还没 ready”导致手机侧首连失败
- daemon / client 都带心跳：server 会回收失联 websocket，client 会在 pong 超时后主动断开并进入指数回退重连，避免死连接占住 session
- daemon canonical mirror 若 `tmux capture-pane` 失败，会显式记录错误；服务继续保留 `buffer-head-request` / `buffer-sync-request` 读接口，但不会引入第二套 snapshot / fallback 语义

## 约束

- 不修改 `@jsonstudio/wtermmod-core`、`@jsonstudio/wtermmod-dom`、`@jsonstudio/wtermmod-react`
- 手机端只做 client
- 运行态改动必须有真机或安装态证据
- `android/evidence/` 是本地证据目录，不应把整批截图/日志历史直接推到 GitHub 主线
