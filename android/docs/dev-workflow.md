# zterm Android Dev Workflow

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

## 跨尺寸布局 / Mac 共享壳门禁

- 任何 phone / tablet / foldable / split-screen / Mac 相关布局变更，先更新 `docs/decisions/0001-cross-platform-layout-profile.md`
- 再同步 `architecture.md`、`ui-slices.md`、`task.md`、`CACHE.md`、`MEMORY.md`、本地 `SKILL.md`
- page component 内禁止散落 breakpoint / platform 分叉真源；统一由 layout resolver 输出 profile
- 大屏实现优先复用**一行多列 + 垂直分屏**的 phone-sized pane 编排，不允许先做一套 desktop-only 页面再“反推兼容”
- future Mac 的实现也必须先沿 shared app-layer / platform shell 的边界推进，不能把 Android 页面逻辑复制一份到 `mac/`


## Terminal buffer 重构门禁

- 任何 terminal buffer / scroll / cursor 改动，先更新：
  - `docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`
  - `.agents/skills/terminal-buffer-truth/SKILL.md`
  - `docs/daemon-mirror-test-plan.md`
- 未完成 ownership 拆分前，禁止继续在 `TerminalView.tsx` 叠加 projection / anchor / scroll patch
- daemon 侧提交前必须证明：它只维护 session canonical truth，只回答 head / range，且每次回复都带 head；不承载显示逻辑，不承载策略
- client 侧提交前必须证明：buffer worker / renderer container / UI shell 已拆开，renderer 不直接驱动 transport

### Terminal 真回环门禁（新增硬规则）

任何 terminal 相关修复，顺序必须是：

```text
先落测试真源文档 / skill
-> 再补测试
-> 再改代码
-> 再跑真实回环
```

禁止反过来：

```text
先改代码
-> 再补解释性测试
-> 最后靠用户手试
```

terminal 修复完成前，必须同时给出以下证据：

1. tmux oracle
2. daemon runtime logs
3. client buffer worker logs
4. renderer commit logs
5. Android APK 真实安装态结果

缺任意一层都不允许宣称修复完成。

### Terminal 自动回归门禁（新增硬规则）

任何 terminal 相关改动，在重新 build APK 前必须先跑完**本地自动回归闭环**。

固定顺序：

```text
先复现
-> 再写/补自动测试
-> 自动测试先失败
-> 再改代码
-> 自动测试转绿
-> 再跑 daemon/tmux 真回环
-> 最后才 build APK
```

禁止：

- 先改代码，再补“解释性测试”
- 只靠人工手机点点点判断是否修好
- 自动测试没覆盖输入/刷新主链就直接发 APK

每次编译前至少要自动验证：

1. initial connect
2. foreground resume
3. cold start -> 进入单个 active tab -> 无输入等待首屏刷新
4. 进入一个 tab 后切到另一个 tab -> 新 active tab 首屏刷新
5. input -> head -> buffer-sync -> render commit
6. reading 上滚与 gap repair
7. input exits reading
8. daemon restart recover

如果某个线上问题不能被本地自动回归稳定复现，就不允许进入“已修复”口径。

## 验证层级

### L1 Unit

- `pnpm --filter @zterm/android type-check`
- 单元测试（如有）

### L2 Function

- 浏览器主路径验证
- 结构验证可使用 portless 输出的 `*.localhost` 地址
- WebSocket/tmux 真连通验证优先使用 `pnpm --filter @zterm/android preview -- --host 127.0.0.1 --port 4173` 的 HTTP 入口，或直接使用 APK/真机
- 新增主机、保存、连接
- 检查 `Connections` 页结构是否和参考图一致
- 检查终端页顶部/底部栏是否和参考图一致
- 若涉及响应式布局，至少补 phone 单 pane + 一个单行双列或三列 profile 的结构验证

### L3 Orchestration

- 多 Tab、切换、关闭、重连

### L4 Runtime

- `pnpm --filter @zterm/android build`
- `npx cap sync android`
- 真机或模拟器安装态验证
- 检查安全区、顶部点击区、底部快捷栏可用性
- 若 Android 需要直接连 `ws://` tmux bridge，Capacitor WebView 必须允许 cleartext：`androidScheme=http` + `usesCleartextTraffic=true`

### L5 Terminal closed loop（terminal 改动必跑）

按 `docs/daemon-mirror-test-plan.md` 至少跑：

- initial connect
- cold start single tab first paint
- switch to another tab first paint
- foreground resume
- input latency
- reading scroll
- input exits reading
- daemon restart recover

并且每个 case 都要同时对齐：

- tmux truth
- daemon head/range
- client buffer
- renderer commit
- 真机画面

## 证据要求

- 截图
- 命令输出
- APK 路径
- logcat / console
- 证据默认落本地 `evidence/<date-task>/`
- `evidence/` 不作为 GitHub 主线提交内容；Git 中只保留目录说明，分享时按需挑选/打包

### 完成证据最低标准

- 截图
- 命令输出
- APK 路径
- 必要时 logcat

### Terminal 修复的额外最低标准

若本轮改动涉及 terminal buffer / render / input / foreground：

- 必须附 `timeline.txt` 或同等时间线证据
- 必须附 client runtime 结构化日志
- 必须证明没有：
  - `localEndIndex > daemon.availableEndIndex`
  - `requestStartIndex == requestEndIndex`
  - `buffer-head` 误当 pull ack
  - `buffer-sync-request` 因 head-only reply 卡住 in-flight pull
  - cold start / tab switch 后 `pullHz == 0 && renderHz == 0`

## UI 结构变更的附加证据

- `Connections` 页截图
- 终端页截图
- 如涉及键盘/快捷栏，补一张展开态截图

## 响应式布局变更的附加证据

- phone 单 pane 截图
- foldable / pad / split-screen 任一**单行多列**截图
- 若涉及 future Mac 方案，补一张桌面窗口编排图或静态 stage 图
- 说明当前截图对应的 layout profile 名称，避免“看起来差不多”但真源不一致

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
