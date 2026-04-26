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
- daemon 只关心 `tmux -> mirror store`，**不关心客户端状态**；client buffer manager 只关心 `daemon -> local buffer`，**不关心 renderer**
- 不提交大批 evidence / 构建物 / node_modules

## Build Defaults
- 根目录命令应代理到 `android/`
- Android 原生工程路径：`android/native/android`
- npm 依赖真源：发布后的 `@jsonstudio/wtermmod-*`
