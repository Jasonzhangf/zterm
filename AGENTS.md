# zterm Agent Rules

## Scope
- 本仓库是 **app-level repo**，当前主线是 `android/`
- `../wterm` 是 fork runtime repo；移动端只依赖其发布后的 npm 包，不把 runtime 源码混入本仓库

## Truth Sources
- `android/docs/spec.md`：产品范围与验收
- `android/docs/architecture.md`：模块边界、数据流、ownership
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
- 不提交大批 evidence / 构建物 / node_modules

## Build Defaults
- 根目录命令应代理到 `android/`
- Android 原生工程路径：`android/native/android`
- npm 依赖真源：发布后的 `@jsonstudio/wtermmod-*`
