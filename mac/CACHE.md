# CACHE — Mac Short-Term Memory

## Current Task

- 任务：按 Android 已冻结的 contract model，对 Mac 客户端继续做完全重写
- 当前切片：runtime contract 第二刀（head-driven follow sync + reading/request gating）
- 当前目标：让 Mac runtime 不再只靠 renderer viewport emit 驱动 buffer-sync，而是开始消费 server `buffer-head` 作为 follow 主触发信号

## Freeze

- follow 底部真相优先来自 server `buffer-head.latestEndIndex`，不是 renderer 本地旧 viewportEndIndex
- reading 请求继续只围绕当前窗口 / missingRanges 发，不主动补全整段历史
- 本轮仍未宣称 split / local tmux / packaged smoke closeout

## Next

1. 继续把 runtime adapter 拆成更清晰的 session head / sync planner / buffer worker 边界
2. 清理旧 `ShellWorkspace` 残留模块与未使用 desktop workspace 编排
3. 再补 packaged smoke
