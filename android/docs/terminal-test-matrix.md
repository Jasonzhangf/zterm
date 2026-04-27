# Terminal Test Matrix

> 目的：把 `terminal-test-loop-checklist.md` 里的要求，映射到**当前已有自动测试**与**仍缺失的测试**。  
> 这份矩阵是执行表，不是角色真源；角色真源仍以 decision 文档为准。

## 1. 使用方式

每次处理 terminal 问题时，先做 3 件事：

1. 在本表里找到对应问题类别
2. 看当前已有哪几个自动测试已经覆盖
3. 若缺口存在，**先补缺口测试**，再允许改代码

---

## 2. 覆盖总览

| 组 | 目标 | 当前状态 | 主要文件 |
|---|---|---|---|
| A | server contract | 已有基础覆盖 | `src/server/buffer-sync-contract.test.ts` |
| B | buffer manager orchestration | 覆盖较强 | `src/contexts/SessionContext.ws-refresh.test.tsx` |
| C | renderer orchestration | 覆盖较强 | `src/components/TerminalView.dynamic-refresh.test.tsx` |
| D | Android IME / input loop | 有基础覆盖，**语音/CJK commit 缺口明显** | `src/pages/TerminalPage.android-ime.test.tsx`, `src/App.android-ime-input-loop.test.tsx` |
| E | first paint / app loop | 已有基础覆盖 | `src/App.first-paint.test.tsx`, `src/App.first-paint.real-terminal.test.tsx` |
| F | renderer scope / visible pane | 已覆盖 | `src/pages/TerminalPage.render-scope.test.tsx` |
| G | local buffer merge/store | 有基础覆盖，但“truth reset 禁止”还缺专项 | `src/lib/terminal-buffer.test.ts`, `src/lib/shared-terminal-buffer.audit.test.ts` |
| H | daemon close loop | 已有实验闭环 | `scripts/daemon-mirror-lab.ts` + `pnpm run daemon:mirror:close-loop` |
| I | APK smoke | 人工 smoke，有 checklist | `docs/terminal-test-loop-checklist.md` |

---

## 3. 逐条映射

## A. server contract

### 目标

- `buffer-head-request -> buffer-head`
- `buffer-sync-request -> buffer-sync`
- range 只按请求窗口返回
- empty / zero-width 仍保持 `buffer-sync` 语义

### 已覆盖

- `src/server/buffer-sync-contract.test.ts`
  - current head 直接来自 mirror store
  - requested range 返回 `buffer-sync`
  - zero-width request 仍是 `buffer-sync`
  - empty mirror 仍是 `buffer-sync`

### 还缺

- [ ] 明确断言：**每次回复都带 head bounds**
- [ ] 明确断言：server 不在 `head/range` 请求路径里触发 planner / rebuild / capture
- [ ] 明确断言：大请求不会被 server 擅自放大成 full-tail
- [ ] **专项断言：daemon 不得因 cursor 改写任何 buffer cell；cursor 若存在，必须走独立 metadata**

---

## B. buffer manager orchestration

### 目标

- cold start / active switch / resume 都进入 head-first 主循环
- far jump 直接拉最新三屏
- near head 只补 diff
- reading 才补 gap
- input 触发 head -> sync -> render
- follow 不补历史 gap
- **window invalid 不得清空已有 local truth**

### 已覆盖

- `src/contexts/SessionContext.ws-refresh.test.tsx`
  - active resume 会 refresh head
  - bootstrap 先 head 后 latest follow window
  - switch connected tab 会主动问最新 head
  - reconnect stale active tab
  - input queue against closed ws -> immediate reconnect
  - follow 不带 `missingRanges`
  - input 强制 fresh head
  - input -> head -> tail fetch
  - old tail pull 完成后立即 catch up
  - reading repair 与 follow tail 并行
  - reconnect 后保持最新 mirror truth
  - daemon revision reset 接受 lower revision
  - active session reconnect 优先
  - far ahead -> jump latest three screens
  - near head -> only tail diff
  - follow 不修旧 gap
  - same endIndex + newer revision -> refresh current follow tail
  - same tail line count after input -> single tail refresh
  - connecting session live head promotion
  - connecting state 持续 polling head

### 还缺

- [ ] **专项断言：`local window invalid` 只能改 request plan，不能 reset 已有 absolute-index truth**
- [ ] **专项断言：anchor mismatch / head mismatch 不得把 local buffer 变空**
- [ ] **专项断言：若已有 local lines，错误窗口判定后仍保留并可被 renderer 消费**
- [ ] **专项断言：大带宽场景下 request range 仍保持三屏 / diff，不会扩大到异常 full-tail**

---

## C. renderer orchestration

### 目标

- first paint 正常
- follow/reading 状态机正确
- reading 不被 live update 拉回
- 输入退出 reading
- follow overdrag 不白屏/不花屏
- 有 gap 时继续显示已有内容
- `mirror-fixed` 长行只裁切不重排
- `mirror-fixed` 开启后左右滑切 tab 自动关闭

### 已覆盖

已现场核对：

- `npx vitest run src/components/TerminalView.dynamic-refresh.test.tsx --reporter=verbose`
- 当前结果：**32 tests passed**

- `src/components/TerminalView.dynamic-refresh.test.tsx`
  - bottom screen render
  - short follow bottom align
  - input reset -> follow
  - return to follow at bottom
  - reading viewport updates + gap markers
  - follow gap 不冻结旧帧
  - follow tail gaps 继续渲染最新 tail
  - same tail window content change -> immediate rerender
  - re-activate hidden reading tab -> follow
  - input reset epoch -> follow
  - reading 不被 live tail yank 回 follow
  - narrowed local window 不强行拉回 follow
  - active re-activate -> follow
  - resize refresh 保持 reading
  - live tail 更新下 reading 仍可继续下滚到底
  - buffer re-anchor physically at bottom -> follow
  - same-session head advance 下保持 reading
  - older history prepend 保持 reading scroll position
  - follow scrolling anchor to actual DOM bottom
  - DOM bottom oversized 不 drift
  - loading only when buffer manager pull active
  - near-bottom slight upward drag -> enter reading
  - first visible frame contains gap 时不全黑

### 还缺

- [ ] **专项：follow 模式到底后继续下拖 / overdrag，不得出现白屏 / 贴图错位 / 重复灰块**
- [ ] **专项：shell 抬升/布局变化时 renderer 仍持续显示已有内容，不产生 blank frame**
- [ ] **专项：窗口不连续时，renderer 不能把已有 absolute-index 内容整屏画空**
- [ ] **专项：`mirror-fixed` 长行默认左裁切，不换行、不重排、不改 buffer truth**
- [ ] **专项：`mirror-fixed` 横向平移只改 renderer 列窗口，不触发 `onResize` / buffer pull / mode change**
- [ ] **专项：`mirror-fixed` 开启后左右滑切 tab 自动关闭**

---

## D. Android IME / input loop

### 目标

- Android 原生 IME 输入走 native path
- quick editor / terminal 焦点交接正确
- 输入后 active tab 自动刷新
- **中文/语音输入法 commit 不需要补一个字符**
- 刷新过程中不会再次失去输入能力

### 已覆盖

- `src/pages/TerminalPage.android-ime.test.tsx`
  - Android 下禁用 DOM terminal focus，走 native IME input
  - quick bar editor 抢焦点时 suspend ImeAnchor routing
  - editor blur 后重新 show ImeAnchor
  - toggle keyboard only show once
  - keyboardDidShow 不重复 re-show
  - native keyboardState 会抬 shell
  - rerender 后不重复 attach listener，且仍路由到最新 active session

- `src/App.android-ime-input-loop.test.tsx`
  - native Android IME input 经过 App -> SessionContext -> renderer 闭环

### 还缺

- [ ] **中文输入法 composition -> commit 自动刷新**
- [ ] **语音输入法转文字自动刷新，不需要补一个字符**
- [ ] **commitText / finishComposingText 到 renderer 刷新闭环**
- [ ] **Android IME 输入后，buffer-sync 前 terminal 可见内容不得先本地变化**
- [ ] **输入后界面开始刷新，但 terminal 不得失去后续输入能力**
- [ ] **刷新期间 keyboard/IME 状态变化，不得把 terminal 再次切回不可输入**
- [ ] **editor overlay 打开/关闭时 ImeAnchor focusable 状态切换正确，不抢 WebView 焦点**

## D.1 prompt / cursor style parity

### 目标

- prompt / input row 样式真相必须来自 mirror payload
- client 不得 local-echo 输入行样式
- daemon 不得在 cursor 路径里改写 prompt/input 行任何 cell truth

### 已覆盖

- `src/contexts/SessionContext.ws-refresh.test.tsx`
  - input 发出后、mirror 未回来前，不会本地把 `typed-from-client` 画到 terminal

### 还缺

- [ ] **App/IME close loop：输入发出后、buffer-sync 前，terminal 可见内容不变**
- [ ] **daemon contract：cursor 不得写进 `lines[].cells[].flags`；buffer truth 在有无 cursor 时必须一致**
- [ ] **renderer parity：收到带样式的 prompt/input row 后，只能回显 payload 的 `fg/bg/flags`**

---

## E. first paint / app closed loop

### 目标

- cold start single tab first paint
- switch-to-another-tab first paint
- foreground resume repaint

### 已覆盖

- `src/App.first-paint.test.tsx`
  - cold start active tab first paint
  - switch to another tab first paint

- `src/App.first-paint.real-terminal.test.tsx`
  - cold start active tab real TerminalPage/TerminalView first paint
  - switch tab real first paint
  - foreground resume repaint

### 还缺

- [ ] **首屏期间若 shell / IME / keyboard 有布局变化，仍不 blank**
- [ ] **active tab 正在 first paint 时输入/语音输入，不得卡住 render or input chain**

---

## F. renderer scope / visible pane

### 目标

- hidden/non-visible renderer 不得继续挂载

### 已覆盖

- `src/pages/TerminalPage.render-scope.test.tsx`
  - single pane 只挂 active renderer
  - split mode 只挂 visible renderers

### 还缺

- [ ] **tab switch during IME active / keyboard shown 时 renderer scope 仍正确**

---

## G. local buffer merge/store

### 目标

- 本地按绝对行号 merge
- 1000 行上限
- prepend / append / revision / gap 行为正确
- **truth 不可因窗口错误被清空**

### 已覆盖

- `src/lib/terminal-buffer.test.ts`
- `src/lib/shared-terminal-buffer.audit.test.ts`
- `src/contexts/SessionContext.ws-refresh.test.tsx`
  - latest 1000 local lines
  - incremental payload apply
  - prepend history stitch without full reset
  - reconnect 后拒绝 stale payload

### 还缺

- [ ] **专项：已有 local absolute-index 内容存在时，window invalid 也不得 reset 成空窗**
- [ ] **专项：renderer 仍可消费 reset 前已有内容**
- [ ] **专项：任何“re-anchor”不能通过抹掉已有 truth 来达成**

---

## H. daemon close loop

### 目标

- tmux truth -> daemon -> payload 闭环真实成立

### 已覆盖

- `scripts/daemon-mirror-lab.ts`
  - `initial-sync`
  - `local-input-echo`
  - `external-input-echo`
  - `daemon-restart-recover`
  - `schedule-fire`
  - `top-live`
  - `vim-live`

### 还缺

- [ ] **单独量化大 payload case：记录 request range / payload bytes / returned line count**
- [ ] **单独量化 direct daemon probe：connect -> head -> input -> head advance 延迟**

---

## I. APK smoke

### 已有文档真源

- `docs/terminal-test-loop-checklist.md`

### 当前仍依赖人工

- 冷启动 active tab
- switch tab
- foreground resume
- 英文/数字/空格/回车
- **语音输入法转文字**
- reading 连续上滚 / 下滚到底
- follow overdrag 白屏/花屏
- 输入后刷新期间是否丢失输入能力
- 5MB 峰值抓现

### 仍缺自动化

- [ ] 真机/半自动录制与日志汇总脚本
- [ ] overlay 指标自动采集
- [ ] 语音输入法专项回放能力

---

## 4. 当前最优先缺口

按你现在的现场问题，优先级应该是：

### P0

1. **Android IME / voice commit**
   - 语音转文字后不自动刷新
   - 刷新后又无法继续输入

2. **renderer overdrag / blank frame**
   - follow 到底继续下拖白屏/花屏

3. **buffer truth reset violation**
   - 任何 `window invalid -> empty local truth`

### P1

4. **5MB payload / request inflation**
   - 加专项日志和自动 case

---

## 5. 下一步测试任务表

执行顺序固定：

1. 补 **voice/CJK commit** 自动测试
2. 补 **follow overdrag blank-frame** 自动测试
3. 补 **buffer truth reset violation** 自动测试
4. 补 **5MB/payload inflation** 自动测试或至少结构化日志断言

只有这 4 组先落了，后面的代码修改才有意义。
