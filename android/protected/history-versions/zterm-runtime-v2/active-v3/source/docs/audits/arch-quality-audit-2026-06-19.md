# 全项目架构质量与合规审计 — 2026-06-19

- 审计范围：`android/src/server/`（核心 daemon） + `docs/function-map.md` + `docs/feature-registry.json` + `docs/architecture.md` + `docs/wiki/` + `test:feature-registry` + `test:contracts`
- 证据：tsc 0 errors，contracts 561 PASS，daemon pid healthy，APK 1839 delivered

## 1. AGENTS.md Hard Guards 合规

| Hard Guard | 当前状态 | 证据 |
|---|---|---|
| H1 读写解耦 | ✅ daemon mirror 写侧（capture+canonicalize）读侧（buffer-head/range reply）完全分离 | `terminal-mirror-capture.ts` 单向写；`terminal-mirror-runtime.ts` 单向读 |
| H5 禁止 fallback/degradation | ✅ 无 fallback/degradation 隐蔽路径 | `terminal-message-runtime.ts` 错误显式报错；buffer-sync 路径只有一条 |
| H7 payload 不可裁剪 | ✅ R13: input 256KB 上限，显式 `input_too_large` 错误 | `terminal-message-runtime.ts:MAX_INPUT_PAYLOAD_BYTES` |
| H11 daemon 无 client 心智 | ✅ `clientSessionId / client state` 未进入 daemon 真相；`disposeLiveMirrorInputBatch` 按 mirrorKey 而非 client session 清理 | `server.ts` terminal-runtime.ts terminal-daemon-runtime.ts 交叉验证 |
| H12 terminal widthMode 冻结 | ✅ `mirror-fixed` daemon 不接受客户端宽度变化；R6 节流 R7 多 sub 宽度安全 | `terminal-mirror-runtime.ts reconcileMirrorAdaptiveWidth` |
| H16 测试设计先行 | ✅ R3/R9/R1/R2/R6/R7/R8/R13 全部有红测 | `terminal-control-runtime.input-queue.test.ts` / `terminal-performance-scheduler.test.ts` 等 |
| H18 Wiki Review 面 | ⚠️ wiki md + html 存在，但 html 用外部 CDN mermaid，未做浏览器实际渲染验证 | `docs/wiki/generated/daemon.html` 用 `cdn.jsdelivr.net` |
| H20 架构 gate 强制 | ✅ `test:feature-registry` + `test:terminal:contracts` 已 gate 化 | `package.json test:feature-registry` 接入 function-wiki-truth |
| H25 测试映射显式化 | ✅ 22 feature_id 全部有 required_gates | `docs/function-map.md` + `feature-registry.json` |

**AGENTS 合规缺口**：
- **A1**：Wiki HTML 用外部 CDN mermaid，不满足"必须能离线渲染"和"浏览器实际渲染验证"要求。应在 `build-function-wiki.mjs` 引入本地 mermaid.js bundle，或改用内联 SVG 生成。

## 2. Function Map 与 Mainline Call Map

- 22 个 feature_id 全部有 owner、allowed_paths、forbidden_paths、required_gates
- daemon input mainline（R3）已绑定：`ws.onmessage → handleMessage → writeInputIfCurrent → disposeLiveMirrorInputBatch / enqueueLiveMirrorInput → runTmuxAsync`
- 多 sub fanout mainline（R1+R2+R14）已绑定：`buffer-head-request → sendBufferHeadToSession → broadcastBufferHeadToSubscribers (lastHeadBroadcastAt dedup) → buildBufferHeadPayload → deps.sendMessage`
- 性能调度 mainline（R9）已绑定：`scheduleMirrorLiveSync → resolveTerminalLiveSyncDelay (flushInFlight min 16ms) → setTimeout`
- resize 节流 mainline（R6+R7）已绑定：`handleAdaptiveResize → reconcileMirrorAdaptiveWidth (250ms 节流 + widthMode 不一致 block）`
- WASM 单例（R8）已绑定：`loadSharedScratchBridge() module-level → captureMirrorAuthoritativeBufferFromTmux`
- 所有 mainline 边都有红测覆盖

**缺口**：
- **F1**：mainline call map 未显式落地（当前散落在 function-map.md 描述文本里）。建议新增 `docs/wiki/mainline-call-map.json` machine-readable manifest。

## 3. Dead Code / 重复实现 / Fallback 隐蔽路径

- server 目录无 `// TODO / // FIXME / // HACK`
- server 目录无空 catch body（`catch (error) {}`）
- server 目录无 deprecated 注释
- client 目录 `fallback` 关键字仅出现在合法语义名（`fallbackEndIndex`/`fallbackActiveSessionId`）
- `terminal-quickbar.tsx` 第 276 行有 `// fallback to manual order` 注释，但这是 UI 排序语义，非 fallback/degradation 路径，注释正确标注即可
- 无第二个 WASM 实例化路径

## 4. Test Design ↔ Impl 一致性

| 风险 | 修复 | 红测 |
|---|---|---|
| WS mock 跨文件串扰（R3 收口后仍偶发） | `activeFactoryCount` mutex 守卫 | `SessionContext.ws-refresh.test.tsx` |
| input 合批（R3 核心） | `disposeLiveMirrorInputBatch` | 3 个反向测试 + input-queue 6 个测试 |
| head fanout N²（R1+R2+R14） | `broadcastBufferHeadToSubscribers` + `lastHeadBroadcastAt` | `terminal-mirror-runtime.test.ts` 锁 head-broadcast |
| fast lane（R9） | flush-in-flight min 16ms | `terminal-performance-scheduler.test.ts` |
| detach 不 0-delay（R10） | `scheduleMirrorLiveSync` 条件判断 | `terminal-runtime.detached-session.test.ts` |
| resize 节流（R6） | `lastResizeAt` throttle | `terminal-mirror-runtime.test.ts` |
| 多 sub widthMode（R7） | `widthModes.size >= 2` block | `terminal-mirror-runtime.test.ts` |
| input 上限（R13） | `MAX_INPUT_PAYLOAD_BYTES` 检查 | `terminal-message-runtime.test.ts` |
| WASM 单例（R8） | `sharedScratchBridgePromise` | `terminal-mirror-capture.test.ts` |

## 5. 工程质量

- tsc --noEmit: **0 errors**
- test:terminal:contracts: **561 PASS / 49 files**
- test:feature-registry: PASS
- build-android-debug.sh: APK **0.1.3.1839** delivered
- daemon restart: pid 健康

## 6. 剩余缺口（按优先级）

| 缺口 | 描述 | 建议 |
|---|---|---|
| Wiki HTML CDN 依赖 | mermaid 来自 cdn.jsdelivr.net，不离线 | 改用本地 mermaid.js bundle 或内联 SVG 生成 |
| mainline call map 未机器可读 | 只有 function-map.md 描述文本，无 JSON manifest | 新增 `docs/wiki/mainline-call-map.json` |
| wiki mermaid 未浏览器验证渲染 | AGENTS gate 18 要求实际浏览器渲染 | 补 `build-function-wiki-render.test.ts` 或人工确认截图 |
| R5 完整实现 | build 抽出但 stringify 仍 per-sub | sendMessage 加 pre-serialized path |
| R11 日志 gate | console.* 未全接入 daemonRuntimeDebug | 收口 console.* → daemonRuntimeDebug |
| R12 session.id 解耦 | transport 重连建新 session | 下个 PR 独立处理 |

## 7. 认证摘要

本项目已达：
- ✅ AGENTS.md 核心硬护栏（除 Wiki HTML CDN 外）全部合规
- ✅ 14 个 daemon 性能风险中的 9 个已修复落地
- ✅ 561 contracts PASS，无 TS 错误
- ✅ daemon restart healthy + APK 1839 发布
- ✅ function map 22 feature_ids 全部有 owner+gate
- ✅ 无 dead code / 无 fallback 隐蔽路径
- ⚠️ Wiki HTML 不离线（CDN 依赖）
- ⚠️ mainline call map 缺少机器可读 manifest
