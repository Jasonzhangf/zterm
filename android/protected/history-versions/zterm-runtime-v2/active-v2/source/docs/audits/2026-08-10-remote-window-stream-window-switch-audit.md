# 2026-08-10 Remote Window Stream 窗口切换独立审计

## 1. 审计范围与结论

审计对象：Remote Window Stream（远程桌面窗口视频串流，`resource.remote_window_stream` + `resource.remote_window_overlay`）中的 **app 窗口切换**能力。不涉及 terminal buffer / mirror / renderer 链路。

现状结论（2026-08-10 代码基线）：

- **单窗口（锁定一个 target 串流）可用**：`handleSelectTarget` → focus 单流 + 组合模式 overview 双流，控制面与渲染面均有测试覆盖。
- **窗口切换控制面（client ↔ daemon ↔ Swift capture 命令面）已闭环**：单元测试 `remote-window-dual-stream-runtime` + `remote-window-stream-daemon` 68 PASS，`RemoteWindowOverlay.test.tsx` 70 PASS + 4 skip；真机 2026-08-09 曾闭环 sibling 切换（accepted → ready → focus-committed，见 MEMORY 1543-1548）。
- **真机"切换不可用"的根因不在控制面单元测试覆盖范围内**，落在 capture 端到端（Swift 进程）与外部权限边界。按可能性排序的断点见 §5。

**2026-08-10 补充（playground H1 闭环，正式源码已修复）**：

- 根因确认（本机 Mac Studio + 正式 capture 源副本实验，`playground/remote-window-window-switch-20260810/`）：
  - 单窗口 `update-config` 复用**启动时** `SCShareableContent` 快照，不重新枚举；capture 启动后新出现的窗口在 `findScWindow` 中 miss → 主循环输出**全黑帧**，且 Swift 立即 ACK `ok:true`（**假阳性**，无窗口存在性验证）→ daemon 视黑帧为正常帧发 `focus-ready` → client 提交黑屏。
  - 组合模式 update-config 会重枚举 content（`remote-window-scripts.ts` 组合分支），故 sibling 组合切换可用、跨窗口单窗口切换黑屏，与用户"单窗口 ok、切换不可用"症状一致。
- 修复（`android/src/server/remote-window-scripts.ts`，playground fixed2 验证后落地）：
  1. 单窗口 update-config：`compositeStopped = true` → 重枚举 content → `findScWindow` 存在性 guard（miss 时 ACK `ok:false` + error，走既有 `update_focus_failed` 错误面）→ `startSingleWindowCapture` 重建；
  2. 引入 `captureLoopGeneration`，组合/单窗口两个主循环同时检查代次——修复旧循环被 `compositeStopped=false` 重置后复活、用旧快照持续发黑帧的竞态（实测黑:内容帧 3:1 交替）。
- 验证：playground 红测（formal 源切换后 8/8 黑帧 + `ok:true`）→ 修复副本（8/8 非黑帧 + ghost 窗口 `ok:false`）→ 正式源重提取后同结果；daemon/capture/dual-stream 测试 74 PASS、overlay 70 PASS + 4 skip、tsc 通过。
- 待办：真机 V1-V5 矩阵（§6）未执行；组合模式 update-config 可加同款存在性 guard 作为加固。

## 2. 切换的两个交互入口

| 入口 | 触发 UI | 语义 | 是否重建流 |
|---|---|---|---|
| child rail tile | 同 app 多窗口时主画面旁/上的子窗口缩略图（`data-remote-window-child-tile`） | 同 app sibling 窗口 focus 切换 | **否**（`updateFocus` 只换 capture target） |
| app switch popover | 顶部 app 切换按钮 → 窗口列表（`remote-window-active-app-switch-*`） | 跨 app / 任意 catalog 窗口切换 | **是**（transactional handoff：新流 start → commit → 旧流 stop） |

两条路径的 owner 都是 `resource.remote_window_overlay`（client 投影/意图）+ `resource.remote_window_stream`（daemon capture/输入真源），符合 `2026-07-19-remote-window-stream-truth.md` 的边界。

## 3. 数据流（文件:行引用）

### 3.1 child tile 切换（updateFocus / dual-stream switch）

```
RemoteWindowOverlay.tsx:4660-4684  child tile onClick
  ├─ setFocusedWindowId(target.videoTarget.windowId)
  ├─ beginRemoteWindowDualStreamSwitch(...)  -> phase=switch-requested, revision+1
  ├─ showRemoteWindowOverviewCrop(...)       -> phase=overview-crop-visible（video 隐藏 + overview canvas crop 占位）
  ├─ setDualStreamSwitch({ ...switchState, focusStreamId })
  └─ updateFocus(sessionId, focusStreamId, target, revision)
        └─ session-context-remote-window-runtime.ts:356 updateRemoteWindowFocusRuntime
        └─ remote-window-message-runtime.ts:325  sendStreamUpdateFocus -> wire { type:'remote-window-stream-update-focus', streamId, revision, target }
              └─ terminal-message-runtime.ts:949 路由 -> deps.remoteWindowStreamRuntime.updateFocus(payload)
                    └─ remote-window-stream-daemon.ts:1367 updateFocus
                          ├─ revision <= entry.focusRevision            -> stale 拒绝
                          ├─ entry.pendingFocusReady 非空                -> busy 拒绝（防覆盖在途 ready）
                          ├─ !captureSource?.updateTarget                -> unsupported 拒绝
                          ├─ await captureSource.updateTarget(focusTarget)   // focusTarget 剥离 compositeWindows
                          ├─ entry.focusRevision = revision; pendingFocusReady = {...}
                          └─ 返回 phase:'accepted'
                          └─ remote-window-capture.ts:333 updateTarget    // stdin 写 JSON update-config + 等 ACK
                                └─ remote-window-scripts.ts:1241 Swift update-config
                                      ├─ compositeWindows 非空 -> startCompositeCapture 重建（重新枚举 SCShareableContent）
                                      └─ 单窗口 -> 更新 singleWindowCapture 真源（复用启动时 content 快照）
                                      └─ writeCaptureUpdate(ok) -> TS updateTarget ACK
                          └─ focus 流下一帧 -> sendRemoteWindowVideoFrame -> pendingFocusReady 发 phase:'ready'
                                └─ stream-daemon.ts:772
              └─ wire { type:'remote-window-stream-focus-result', revision, targetId, streamId, phase }
                    └─ RemoteWindowOverlay.tsx:2648 匹配 current.revision/pendingTargetId/focusStreamId
                          ├─ accepted -> markRemoteWindowFocusUpdating (focus-updating)
                          ├─ ready    -> acceptRemoteWindowFocusReady + commitRemoteWindowFocusProjection (focus-committed)
                          └─ error / remote-window-error -> failRemoteWindowDualStreamSwitch
```

超时兜底：`overview-crop-visible` 3s 无 ready → `resetRemoteWindowDualStreamSwitch` 拉回 `focus-committed`（overlay 917-930），避免永久黑屏。

### 3.2 app switch popover 切换（transactional handoff / 重建）

```
RemoteWindowOverlay.tsx:4754-4794  renderSwitchTargetRow onClick
  └─ handleSelectTarget(target)   (overlay 2777)
        ├─ effectiveTarget = attachSameAppCompositeWindows(target, catalogTargets)  // 同 app 窗口自动聚合进组合
        ├─ handoff = { previousStreamId, pendingStreamId: focusStreamId, ... }      // 存在旧流时
        ├─ beginRemoteWindowStreamHandoff(...)  // 新流 start 前保持旧流/旧媒体存活
        ├─ startStream(... purpose:'focus')     // 单连接双 transceiver：compositeWindows 非空时同 peerConnection 加 overview track
        │     └─ daemon start：focus capture（主窗口，剥离 compositeWindows）+ overview capture（全窗口 canvas，2mbps）
        ├─ focusResult 到达且 epoch/pendingStreamId 匹配 -> commitRemoteWindowStreamHandoff
        │     └─ activeStreamIdRef 切到新流 -> stopStaleStream(previousStreamId)
        └─ 失败 -> failRemoteWindowStreamHandoff（旧流保持可用，不切断）
```

历史教训（已修复，见 MEMORY）：
- 1515：`handleSelectTarget` 曾双流（preview canvas + focus）并存饿死 focus，后单流化；
- 1547：dual-stream 控制面 wire `streamTargetId`（`app-window:<pid>:<windowId>`）与 UI `windowId` 混用会吞掉 ready、永久停在 `overview-crop-visible`；当前代码已分离（`pendingTargetId=streamTargetId`，`overviewCropTargetId=windowId`）。

## 4. 已闭环事实（证据）

- `npx vitest run src/lib/remote-window-dual-stream-runtime.test.ts src/server/remote-window-stream-daemon.test.ts` → **68 PASS**（含 updateFocus stale/busy/unsupported、capture updateTarget、focus-ready 时序）。
- `npx vitest run src/components/terminal/RemoteWindowOverlay.test.tsx` → **70 PASS + 4 skip**（含 sibling click 走 updateFocus、handoff commit 后旧流 stop、dual-stream 缩回浮窗 reset、focus-result 不匹配兜底）。
- daemon 入口路由 `remote-window-stream-update-focus` → `updateFocus`（terminal-message-runtime.ts:949）接通。
- Swift `CaptureCommand` 字段与 TS `updateTarget` JSON 完全一致（remote-window-scripts.ts:868 / remote-window-capture.ts:333-356）。
- 2026-08-09 真机闭环记录（MEMORY 1548）：focus 580x385 + overview 1920x1080 双 track 首帧 ready，点击 sibling 收到 accepted/ready，最终 focus-committed。

## 5. 真机"切换不可用"断点分析（按可能性排序）

> 单窗口可用 ⇒ 权限与 capture 对"已存在窗口"路径是通的；断点集中在"切换目标与启动时 capture 状态的差异"。

### H1（高）：单窗口 `update-config` 复用启动时 `SCShareableContent` 快照，新窗口找不到

- `remote-window-scripts.ts:1209`：capture 进程启动时枚举一次 `SCShareableContent`，此后主循环 `findScWindow(windowId:..., content: content)`（1067-1078）始终在**这份快照**里按 `windowID` 匹配。
- 单窗口 `update-config`（1282-1297）只替换 `singleWindowCapture` 的 windowId/bounds/crop，**不刷新 content**；而组合分支（1251）会重新 `SCShareableContent.excludingDesktopWindows`。
- 后果：切换目标若不在启动快照（切换时才新建的窗口、windowID 变更、窗口被 `onScreenWindowsOnly` 过滤）→ `findScWindow` 返回 nil → `compositeFrameLoop` `continue` 静默跳帧 → **focus 流停帧** → daemon `pendingFocusReady` 等不到首帧 → client 卡 `focus-updating` → 3s 超时 reset → 画面仍是旧窗口/黑屏，表现为"切换不能用"。
- 修复方向：单窗口 update-config 与组合分支对齐，重建前重新枚举 `SCShareableContent`。

### H2（高）：focus-ready 依赖"updateTarget 后下一帧"，Swift 停帧时 daemon 无显式错误

- daemon 只在 focus 流下一帧到达时发 `ready`（stream-daemon.ts:772-778）；Swift 侧任何"不再出帧"的失败（窗口关闭/最小化、截图抛错仅 `stderrLine` 不退出、主循环 `break`）都不会产生 wire 错误。
- client 只能等 3s 超时 reset；且 reset 后 `activeTargetId` 仍是旧值——"切换失败但界面不报错"。
- 修复方向：daemon 在 `updateTarget` ACK 后启动"N 秒内无帧"计时，超时主动发 `focus-result phase:'error'`；Swift 截图失败升级为可见 stderr + 可选 error frame。

### H3（中）：update-config 与单窗口主循环的帧级竞争

- 主循环每帧 `guard let windowEntry = singleWindowCapture`（1191-1194）取**快照**；update-config 在帧间隙换真源。切换瞬间可能多出 1 帧旧窗口画面（视觉小瑕疵，最终收敛，非致命）。
- 修复方向（可选）：update-config 期间让主循环暂停一帧（如加 generation 计数）。

### H4（中）：并发切换（handoff 与 updateFocus 交错）无专门防护测试

- child tile 用 `dualStreamSwitch.focusStreamId`（切换时捕获的旧 focus 流 id），若同一瞬间发生 app switch handoff（`activeStreamIdRef` 更新），focus-result 的 streamId 校验不匹配被吞 → 走超时 reset。已有 epoch/revision 防重入，但并发路径无测试。
- 修复方向：补"child tile 点击后 500ms 内触发 app switch"的交错测试。

### H5（低）：overview crop 过渡期占位错误

- `focusedWindowSlot` 在 `compositeLayout.windows` 里按 `focusedWindowId` 查找，找不到时 fallback `windows[0]`（overlay 935-937）；切到不在 `state.target.compositeWindows` 快照里的窗口时，过渡期 crop 显示主窗口区域。focus-ready 后主视频恢复正确。
- 修复方向：crop 阶段找不到 slot 时显示"切换中"占位而非错位画面。

### 外部环境（非代码，已记录）

- **TCC Screen Recording 权限**：MEMORY 1553-1558 记录了 launchd daemon / capture 子进程身份未获授权时 `SCStreamErrorDomain Code=-3801`、一帧不出。H14 结论：helper-only 授权不够，需 launchd/Node responsible-process 身份在系统 Screen Recording 授权列表。若用户环境单窗口确有画面，此项大概率已满足，但**每次重新部署 daemon / 更换机器后需复查**。

## 6. 修复与验证思路

### 阶段 0：环境基线（先排除外部阻断）

1. 在 daemon 所在 Mac 确认 Screen Recording 授权列表包含当前 daemon/capture 进程身份（launchd label 或直接运行 shell 身份）。
2. `playground/remote-window-dual-stream-20260809/` 的 probe 脚本复跑：单窗口 capture 首帧 + 组合 capture 首帧，确认无 `-3801`。
3. 记录 `framesSent` / `focus-result` 日志：单窗口正常、切换后是否停帧。

### 阶段 1：代码加固（按 §5 顺序）

1. Swift 单窗口 `update-config` 重新枚举 `SCShareableContent`（对齐组合分支），消除 H1。
2. daemon `updateTarget` 后加"无帧看门狗"，超时主动发 `focus-result phase:'error'`（消除 H2 的静默等待）。
3. Swift `findScWindow` miss 时输出明确 stderr 行（当前静默 continue），便于真机定位。
4. 补 H4 并发交错测试、H5 crop 占位测试。

### 阶段 2：真机验证矩阵（证据链）

| # | 场景 | 期望 |
|---|---|---|
| V1 | 同 app 两窗口 A/B，A→B child tile 切换 | accepted → ready → focus-committed；主视频切到 B；B 上 click/scroll 生效 |
| V2 | 跨 app 切换（app switch popover A→C） | handoff：新流 start → 旧流 stop；无黑屏空窗；C 窗口画面与输入正确 |
| V3 | 切换后新建窗口 C'，catalog 刷新后切到 C' | 单窗口 update-config 找到 C'（验证 H1 修复） |
| V4 | 停掉 Swift capture 进程后点击切换 | 3s 内出现显式错误投影，不永久卡 `focus-updating`（验证 H2 修复） |
| V5 | 缩回浮窗 / Back 时切换在途 | `resetRemoteWindowDualStreamSwitch` 生效，不残留 pending |

### 阶段 3：门禁

- 定向测试：dual-stream-runtime + daemon + overlay 全绿；
- type-check + `build:android` + OTA 发布（按 AGENTS.md Build Defaults）；
- 真机 V1-V5 证据落 `android/evidence/`。

## 7. 相关文件地图

- 真源：`docs/decisions/2026-07-19-remote-window-stream-truth.md`、`docs/resource-registry.json`（`remote_window_overlay` / `remote_window_stream`）
- Client UI：`src/components/terminal/RemoteWindowOverlay.tsx`（切换 UI + 状态机接线）
- Client runtime：`src/lib/remote-window-dual-stream-runtime.ts`、`src/lib/remote-window-message-runtime.ts`、`src/contexts/session-context-remote-window-runtime.ts`
- Daemon：`src/server/remote-window-stream-daemon.ts`（updateFocus / 双流 / focus-ready）、`src/server/remote-window-capture.ts`（updateTarget）
- Swift capture：`src/server/remote-window-scripts.ts`（`update-config`、单窗口/组合主循环）
- 路由：`src/server/terminal-message-runtime.ts:949`
- 历史：`android/MEMORY.md` 1515 / 1541 / 1543-1558
