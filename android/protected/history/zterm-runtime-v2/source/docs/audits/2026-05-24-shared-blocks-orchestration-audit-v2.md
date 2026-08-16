# zterm Android 架构审计报告 v2：共享函数库 + blocks + 纯编排

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计基线：`android/docs/audits/2026-05-24-shared-blocks-orchestration-audit.md`
- 本报告定位：在原始架构审计基础上，补充 2026-05-24 当天重构推进后的真实状态、破损点、收口建议与 `/goal` 配套执行口径。

## 1. 执行摘要

结论分两层：

1. 从长期架构看：代码库仍然是“部分达标，未完全达标”。
2. 从当前工作树看：`TerminalPage.tsx` 正处于一次未完成的 interaction runtime 抽离中，当前不是稳定达标态，而是“helper/copy/overlay 三批收口已成功，interaction 第四批接入失败导致编译破损”。

因此，本次审计不能给出“已经按共享函数库 + blocks + 纯编排彻底完成”的结论；更准确的判断是：

```text
shared/helper leaf 层：已成立，且继续健康
page-local blocks 层：已部分成立（copy/overlay 已落地）
TerminalPage 纯编排壳：尚未完成，当前还处于破损中间态
```

唯一主结论不变：

> `android/src/pages/TerminalPage.tsx` 仍然是当前最关键、唯一主热点；必须先恢复 green，再按小步 slice 完成 interaction runtime 收口，才能真正证明“纯编排壳”成立。

## 2. 本次增量审计的新增证据

### 2.1 当前文件体量

实测：

- `android/src/pages/TerminalPage.tsx`: `2467` 行
- `android/src/pages/useTerminalPageInteractionRuntime.ts`: `173` 行
- `android/src/pages/useTerminalPageCopyRuntime.ts`: `197` 行
- `android/src/pages/useTerminalPageOverlays.ts`: `233` 行

说明两件事：

1. `TerminalPage.tsx` 已比原始审计时明显变薄，说明 helper/copy/overlay 抽离不是口头计划，而是已经发生的物理收口。
2. 即便已经下降到 2467 行，它依然远大于纯编排壳应有体量，且当前 interaction 接线破损，说明“行数下降”不等于“架构完成”。

### 2.2 当前编译状态

执行：

```bash
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

当前错误可分两类。

第一类：未清理完的 unused 声明，例如：

- `registerClientDebugSnapshotSource`
- `normalizeTerminalCommittedText`
- `resolveKeyboardLiftPx`
- `VirtualKeyboardApi`
- `NETWORK_BANNER_GRACE_MS`
- `toPersistedOpenTab`
- `setNetworkOnline`
- `setConnectionIssueVisible`
- `quickBarHeight`
- `setQuickBarEditorFocused`
- `connectionIssueTimerRef`
- `updateTerminalKeyboardRequested`
- `updateKeyboardInset`

第二类：真实破损的缺失引用，例如：

- `currentPersistedTabs`
- `terminalImeActive`
- `effectiveKeyboardLiftPx`
- `quickBarShellKeyboardLiftPx`
- `handleToggleKeyboard`
- `layoutProfile`
- `handleQuickBarEditorDomFocusChange`
- `landscape`
- `terminalChromeBottomPx`
- `terminalImeLiftPx`
- `fileTransferAvoidSide`

这证明当前 `TerminalPage.tsx` 不是“仅剩清理工作”，而是 interaction runtime 抽离时错误切断了 page shell 仍需要消费的一组 owner 值。

### 2.3 当前 interaction runtime 的真实状态

`android/src/pages/useTerminalPageInteractionRuntime.ts` 已存在，但当前只稳定承载了下面这部分语义：

- `interactiveSession`
- `uiSession`
- `uiSessionId`
- `livePaneSessionIds`
- `livePaneSessionIdsKey`
- pane attach intent apply effect
- live session ids report effect
- `handleSwipeTab`
- 多个 page 级 ref 同步

这说明 interaction runtime 已经不是空壳；但 page 侧接线并未同步收完，导致 owner 边界一半迁走、一半悬空。

## 3. 对“是否符合共享函数库 + blocks + 纯编排”的重新判定

### 3.1 shared/helper leaf 层

这层比原始审计更强，不是更弱。

当前已确认存在并已接入的 page leaf：

- `android/src/pages/terminal-page-render-keys.ts`
- `android/src/pages/terminal-keyboard-lift.ts`
- `android/src/pages/terminal-copy-selection.ts`

这些模块满足：

- 输入输出明确
- 无 page JSX owner
- 可单测
- 可独立演化

结论：helper leaf 方向已经被代码验证为正确路线，且是 `TerminalPage` 收口最成功的一步。

### 3.2 blocks/page-local runtime 层

当前已真实落地两个 page-local blocks：

- `useTerminalPageCopyRuntime.ts`
- `useTerminalPageOverlays.ts`

并且根据已有 note/evidence，这两批在接入后曾经通过：

- copy runtime tests
- overlay runtime tests
- `TerminalPage.android-ime.test.tsx`
- `TerminalPage.render-scope.test.tsx`
- `tsc --noEmit`

这说明 page-local block 不是假拆分，而是已经有过 green 证据。

但 interaction runtime 当前尚未完成，因此 blocks 层的结论应改写为：

> `TerminalPage` 相关 blocks 已经从 0 进展到 3/4，但最后一块 interaction runtime 尚未完成闭环。

### 3.3 纯编排层

这里仍不能判定达标。

原因不是抽离方向错，而是：

1. page shell 仍然过厚
2. interaction 接线破损
3. 仍残留若干 page 内 owner 值没有冻结归属

因此当前更准确的描述是：

```text
TerminalPage 正从混合页向纯编排壳收口，
但尚未完成，且当前工作树处于编译失败中间态。
```

## 4. 当前最关键的问题，不是“方向”，而是“收口顺序失稳”

helper → copy runtime → overlays runtime 这三步都说明路线正确。

当前出问题的是 interaction runtime 这一批把过多语义一次性迁走，导致：

- page 仍然引用旧 owner
- hook 只迁入了部分 owner
- 一些 layout/IME/quickbar 派生值没有被重新安置

这不是架构思路错误，而是切片粒度错误。

也就是说，当前主问题不是：

- 不该抽 interaction runtime
- 不该做 page 纯编排

而是：

- interaction runtime 一次搬太多，违反了“每 slice 可独立验证”的节奏

## 5. 改进空间与修复顺序

### P0：先恢复 green baseline，而不是继续从破损态扩张

唯一正确顺序：

1. 先修回 `TerminalPage.tsx` 编译通过
2. 保住已验证通过的 helper/copy/overlay 三批结果
3. 再重新推进 interaction runtime

原因：

- 当前阻塞不在 shared，不在 SessionContext，不在 server
- 也不在 copy/overlay 模块本身
- 唯一阻塞就是 `TerminalPage.tsx` 当前接线断裂

如果不先恢复 green，而继续追加抽离，只会把“唯一热点”从结构热点升级为状态不明热点。

### P1：interaction runtime 必须改成小步 slice，而不是一次性搬空

建议按下面顺序推进。

#### Slice A：只稳定派生态 owner

先只抽：

- `interactiveSession`
- `uiSession`
- `uiSessionId`
- `renderedPaneSessions` 消费后的 `livePaneSessionIds`
- `livePaneSessionIdsKey`

要求：

- 不碰 IME
- 不碰 quickbar
- 不碰 layout profile
- 不碰 file transfer avoid side

目的：先证明 page shell 可以消费 interaction runtime 的“会话/分屏交互真相”，而不是一口气带走所有 UI 派生态。

#### Slice B：只接 pane attach / live session report effect

只迁：

- pane attach intent consume
- live session ids change report

这两个 effect 已在 hook 中出现，应确认 page 侧不再重复 owner。

#### Slice C：只接 tab/pane interaction handler

只迁：

- `handleSwipeTab`
- 必要时迁 `handleSwitchSessionFromChrome` 一类纯交互转发器

要求：

- handler 迁移后必须物理删除 page 中旧逻辑
- 不把 keyboard/layout 混进同一批

#### Slice D：最后再处理 IME / quickbar / layout 派生态

当前缺失引用中，下面这些更像 UI shell 派生，而不是 interaction runtime 必须先拥有的真相：

- `terminalImeActive`
- `effectiveKeyboardLiftPx`
- `quickBarShellKeyboardLiftPx`
- `layoutProfile`
- `terminalChromeBottomPx`
- `terminalImeLiftPx`
- `fileTransferAvoidSide`

这组值不应在 interaction runtime 尚未稳定时一起搬走。更合理做法是：

- 先重新确认它们属于 page shell 组合态、keyboard helper 组合态、还是独立 UI runtime
- 再决定是否抽新 hook

也就是说，这组值当前最大的改进空间不是“尽快搬文件”，而是“先重新判 owner”。

### P2：为 `TerminalPage` 补结构门禁

原始审计已经提过 file-size/import/truth-owner gate；基于这次破损，建议把 page 级门禁再具体化：

1. `TerminalPage.tsx` 行数警戒继续保留，最终目标 `<800`
2. page 不允许同时存在“hook owner + page duplicate owner”
3. 每完成一批抽离，必须跑定向 `tsc + vitest`
4. 任何新 hook 接入前，先列出“输入 owner / 输出 owner / page 删除点”三张表

这样可以避免再次出现“hook 迁入一半、page 删除一半”的中间态。

## 6. 模块级最新判定

### `android/src/pages/TerminalPage.tsx`

判定：仍不合格，但比原始审计时更接近目标态。

原因：

- helper/copy/overlay 已经抽出，说明确实在往纯编排推进
- 但 interaction runtime 接入失败，当前甚至未达到稳定可编译状态

因此它的最新状态不是“纯编排失败”，而是“纯编排推进到最后一大块时卡在中间态”。

### `android/src/pages/useTerminalPageCopyRuntime.ts`

判定：合格。

原因：

- 有明确单一责任：copy selection state machine
- 曾有 targeted tests + page 回归 + tsc 绿证据
- owner 清晰，未见双真源迹象

### `android/src/pages/useTerminalPageOverlays.ts`

判定：合格。

原因：

- overlay/sheet/debug/screenshot preview 协调已迁出 page
- 曾有 targeted tests + page 回归 + tsc 绿证据
- 责任边界清楚

### `android/src/pages/useTerminalPageInteractionRuntime.ts`

判定：方向正确，当前未完成。

原因：

- 文件本身承载的能力边界大体正确
- 但接入粒度过大，导致 page shell 断裂
- 需要缩小切片，而不是否定该 hook 的存在价值

## 7. 最终判定

### 7.1 现在代码是否已经按“共享函数库 + blocks + 纯编排”设计？

结论：还不能说“已经完全按该方式设计完成”。

更准确的说法是：

- shared/helper leaf：达标
- page-local blocks：大体达标，但 interaction 仍未收完
- pure orchestration shell：`TerminalPage.tsx` 还未完成，且当前工作树处于破损态

### 7.2 当前唯一主目标是什么？

唯一主目标依然是：

> 修复并完成 `TerminalPage.tsx` 的 interaction runtime 收口，让它真正退回纯编排壳。

唯一性论证：

1. shared/helper 层已经被本轮重构证明有效，不是当前真瓶颈。
2. copy runtime 与 overlays runtime 已经形成稳定 owner，不是当前真瓶颈。
3. 当前全部编译错误都直接指向 `TerminalPage.tsx` 接线断裂，而不是 shared/SessionContext/server 真源错误。
4. 因此唯一正确的下一步不是泛泛“继续优化架构”，而是先把 `TerminalPage.tsx` 从破损中间态收回 green，并完成最后一块 interaction runtime 划界。

## 8. 建议执行顺序

1. 修复 `TerminalPage.tsx` 当前缺失引用，恢复 `tsc` 通过
2. 重跑已知 targeted suite，确认 helper/copy/overlay 三批成果仍为真
3. interaction runtime 按 Slice A/B/C/D 逐步接入
4. 每个 slice 完成后物理删除 page 中旧 owner
5. 最后再追求 `TerminalPage.tsx < 800` 的纯编排终态

## 9. 给 `/goal` 的结论化表述

对后续执行者，最重要的不是重复大段背景，而是明确：

- 当前不是从 0 开始
- helper/copy/overlay 已成功
- 当前唯一阻塞是 interaction runtime 接线破损
- 必须先恢复 green，再小步完成最后一块收口
