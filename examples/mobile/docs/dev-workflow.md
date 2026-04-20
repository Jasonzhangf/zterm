# wterm-mobile Dev Workflow

## 总原则

- 先冻结真源，再写代码
- 先验证，再结论
- 先证据，再宣称完成
- 先沉淀规则，再继续实现

## 标准流程

```text
Review -> Freeze -> Implement -> Verify -> Evidence -> Distill
```

## 任务开始前

必须写清楚：

- 目标
- 成功标准
- 验证入口
- 范围
- 不在范围
- 证据输出位置

## 开发阶段

- 每次只做一个可验证切片
- 只改本轮需要的文件
- runtime 改动不凭编译通过结论收口
- 页面级重构先按 `docs/ui-slices.md` 切片，不跨页混改

## 设计参考使用规则

- 先冻结主参考图和次参考图，再进入实现
- 实现时优先对齐信息结构和交互结构，不先做视觉细节抛光
- 如果当前 UI 与参考图冲突，先修布局和入口结构，再修功能细节
- 参考图只约束 UI 结构，不替代功能验证

## 验证层级

### L1 Unit

- `pnpm --filter @wterm/mobile type-check`
- 单元测试（如有）

### L2 Function

- 浏览器主路径验证
- 结构验证可使用 portless 输出的 `*.localhost` 地址
- WebSocket/tmux 真连通验证优先使用 `pnpm --filter @wterm/mobile preview -- --host 127.0.0.1 --port 4173` 的 HTTP 入口，或直接使用 APK/真机
- 新增主机、保存、连接
- 检查 `Connections` 页结构是否和参考图一致
- 检查终端页顶部/底部栏是否和参考图一致

### L3 Orchestration

- 多 Tab、切换、关闭、重连

### L4 Runtime

- `pnpm --filter @wterm/mobile build`
- `npx cap sync android`
- 真机或模拟器安装态验证
- 检查安全区、顶部点击区、底部快捷栏可用性
- 若 Android 需要直接连 `ws://` tmux bridge，Capacitor WebView 必须允许 cleartext：`androidScheme=http` + `usesCleartextTraffic=true`

## 证据要求

- 截图
- 命令输出
- APK 路径
- logcat / console
- 证据默认落本地 `examples/mobile/evidence/<date-task>/`
- `evidence/` 不作为 GitHub 主线提交内容；Git 中只保留目录说明，分享时按需挑选/打包

### 完成证据最低标准

- 截图
- 命令输出
- APK 路径
- 必要时 logcat

## UI 结构变更的附加证据

- `Connections` 页截图
- 终端页截图
- 如涉及键盘/快捷栏，补一张展开态截图

## 记忆规则

- `CACHE.md`：本轮短期上下文
- `MEMORY.md`：可复用长期经验
- `SKILL.md`：跨任务门禁和反模式

## skill 更新触发

满足任一条件就更新：

- 出现新门禁
- 出现新反模式
- 出现可复用动作
- 出现重复失败模式
