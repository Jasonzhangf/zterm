# Evidence

这里放本项目的验证证据。

> 规则更新：`evidence/` 是**本地证据仓**，默认**不提交到 GitHub 主线**。
> Git 中只保留本 README，用来说明目录结构与取证规范。

## 推荐结构

```text
evidence/
├── 2026-04-18-foundation/
│   ├── screenshots/
│   ├── logs/
│   └── apk/
```

## 规则

- 只放可复核证据
- 不放大体积构建缓存
- 不放临时草稿
- 截图 / logcat / build log / APK 路径清单等都放本地 `evidence/`
- 若需要分享证据，按任务目录单独打包或挑选上传，不把整批历史证据直接推到 repo

## 当前 terminal foreground-resume 证据索引

原始日志、DOM/health 快照与安装态截图仍保留在本地 ignored evidence 目录；主线只记录可复核索引。

- Base：`897040f7f46da8f11c31eea0ccc075e47128a9df`
- 本地 focused：`session-context-buffer-runtime.test.ts` + `buffer-frame-assembly` 97/97 PASS；`tsc --noEmit` PASS；`test:feature-registry` 105/105 PASS
- daemon/tmux close loop：`android/evidence/daemon-mirror/2026-09-20/`，9/9 real cases PASS，`strict-audit.json` `ok=true`（该证据早于当前 candidate，仅证明 daemon/mirror 主链）
- 历史 exact APK + emulator replay（旧 candidate，不代表当前 candidate）：
  - `bug-8fdaeec-foreground-refresh-main-0919-r4/`：candidate `19c4e296a1040eff486175d38e6e29aabc8685c3`
  - `bug-8fdaeec-foreground-refresh-main-0919-r5/`：candidate `722b45242a8602543a9684f26171c0bf735cc6ae`
- 历史 exact APK 设备回放（candidate `978f84b73f1f545cefb6c8a4ca02d915d6e36b01` / tree `ad252b9af21422e2f84dd727abf80aa28707a718`，已被后续 candidate 取代，不代表当前 candidate；`0.1.3.3066` / `versionCode=1100030660` / APK sha256 `c473b538c1ff69df0a8102249b0c1656f5c8ab767c26b517f0c6bbcbf48391a9`）：
  - 真机 `100.104.163.65:5555`：安装前后保留应用数据，HOME 后只切换 localhost mock payload，再回前台；active session 未切换，DOM 从 `MOCK_INITIAL_4F31A` 更新为同时包含 `MOCK_RESUME_7C92B`；mock `connections` 前后均为 2、`closed=0`。
  - 模拟器 `emulator-5556`：同一 HOME -> 前台入口通过；active session id 保持不变，DOM 从 initial-only 更新为同时包含 `MOCK_RESUME_7C92B`；mock `connections` 前后均为 2、`closed=0`。
  - 两次 mock 均只监听 `127.0.0.1`，未创建、关闭、resize 或写入任何 tmux session；mock 日志中的 resume 请求覆盖 `knownRevision=2 -> targetHeadRevision=1`。
  - incomplete frame owner gate：`session-context-buffer-runtime.test.ts` 的 staged body-first 与 retained multi-chunk 两条 timeout 测试 2/2 PASS，断言 15s lifetime 到期后请求精确 repair range `100-104`。
- 历史 exact-candidate 可复核索引：`android/evidence/bug-8fdaeec-fg-refresh-main-0919-exact-r2/`
- 当前 candidate `8c6183d4`（build 3067）；被测试 revision 为 `8c6183d471cdc7d147bb1c348a1a356d12621ec4` / tree `c6f9be67a18b1a889980d3ab310a5524c039e811`：
  - 命令：`cd android && pnpm exec vitest run src/contexts/session-context-buffer-runtime.test.ts src/contexts/session-context-pull-runtime.test.ts src/contexts/session-context-socket-runtime.test.ts --reporter=dot`
  - 结果：exit 0；`Test Files  3 passed (3)`、`Tests  96 passed (96)`（`session-context-buffer-runtime.test.ts` 79 + `session-context-pull-runtime.test.ts` 5 + `session-context-socket-runtime.test.ts` 12）
  - 原始输出按项目规则保留在本地 ignored 目录 `android/evidence/fg-refresh-mainline-0920/focused-vitest.txt`（`evidence/` 默认不入库）；本索引记录的命令与计数可直接复现。本次提交只改本 README，未改动 `android/src`，因此上述 revision/tree 即被测试源码
  - `43377946` 已按 exact-main lineage 在真机 `100.104.163.65:5555` 重跑 `0.1.3.3067` 设备回放：`adb install -r` 保留应用数据；HOME -> 同一 MainActivity 前台且不切 session 后，active session 保持 `session-1789919271377-853l25hl`，DOM 同时包含 `MOCK_INITIAL_4F31A` 与 `MOCK_RESUME_7C92B`；mock `connections` `1 -> 1`、`closed=0`，resume 请求覆盖 `knownRevision=2 -> targetHeadRevision=1`。本轮只使用 `127.0.0.1` mock，未执行任何 tmux 操作。证据：`android/evidence/bug-8fdaeec-fg-refresh-main-0919-main-3067/real-device-3067-resume.json` 与同目录 package dump。
  - `978f84b7` 的 `0.1.3.3066` 真机/模拟器回放保留为上一代历史证据；当前 `0.1.3.3067` 验收以上条为准。
  - 当前 candidate 的 OTA/公开 Relay 发布：本地 `~/.zterm/updates/latest.json` 已指向 `0.1.3.3067`（sha256 `d47c641c788eb42e353cebd8da15e1aa76dc4662fcd5b08e28eea6bd0894a52e`）；公开 Relay 发布是独立授权阶段，尚未执行。

## rwd-geometry-gesture-0920 真机回放索引

候选 `e9b08c81`（`fix/rwd-geometry-gesture-0920`，base `e9a5fd26` = origin/main）在 15t 上的真机回放；原始记录保留在本地 ignored 目录 `android/evidence/rwd-geometry-gesture-0920-15t/replay.txt`。

- 设备与产物身份：`100.104.163.65:5555`（PLZ110，`ro.serialno 3B162D0024S00000`），`versionName 0.1.3.3067` / `versionCode 1100030670`，`firstInstallTime 2026-09-18 12:20:15` 保留（`adb install -r`），安装态 APK sha256 `d2a260b2e49adbcdc6af7cc547fd8a35daf6e0497b5c169d46f0fea0f704cdb0` 与 host `android/native/android/app/build/outputs/apk/debug/app-debug.apk` 完全一致。
- 真实入口：Mac Studio daemon 0.1.3（launchd）→ tmux `zterm-3` → 远程窗口 Finder `app-window:29243:37285`；解码视频 `readyState 4`、`720x1065`、`currentTime` 推进。
- 观测层：远端输入在真实传输边界取证（`Capacitor.nativePromise` / `toNative`，plugin `AndroidConnectionService`）。Android 传输是 native Capacitor plugin，不是 DOM WebSocket，DOM `WebSocket.prototype.send` 钩子记录为 0，不构成证据。
- A 缩放后全屏单指完全 no-op：pinch 后 content `{x:-452,y:-423,w:1243,h:1839}`，真实 `adb shell input swipe 608 2000 608 1400 300` 后 rect 不变（dx=dy=dw=dh=0），`remote-window-input` 计数 0 → PASS。
- B 缩放后全屏双击不重置投影（`ddf9613d`）：真实 100ms 内两次 `input tap 608 1740`，rect 保持不变 → PASS。
- C 双指同向为实时远端 scroll：双指 100px 同向位移，本地投影不变，传输层出现 `remote-window-input`（`rw-input-1789936500393-27` phase=start x=2111.85 y=1277.22 dy=46.23，随后 8 个 update）→ PASS。
- D pinch 缩放：in `{8,252,331,490}` → `{-452,-423,1243,1839}`（dw=+912 dh=+1349）；out 精确还原（dw=-912 dh=-1349），不缩到 fit 以下 → PASS。
- E 1x 单击：真实 `input tap` 后恰好 1 条 `remote-window-input`，`event.kind=click`、`button=left`、`seq rw-input-1789936677337-46` → PASS。
- F 全屏进入/退出链条：抽屉把手真实上滑 → `data-mode floating→fullscreen` 且 toolbar 出现；`缩小远程窗口` → `fullscreen→floating`；`关闭远程窗口` → overlay 与 bottom sheet 同时消失，无需杀 App → PASS。
- 未覆盖：embedded（半截抽屉）floating 的 pinch 在本轮未改变 content rect（该路径不是本候选两个缺陷的修复对象）；daemon 启动错误不再被 cleanup 失败覆盖（`f8dcac3f`）由 `remote-window-capture.test.ts` 单测覆盖，本轮未在设备上重导。

## rwd-geometry-gesture-0920 主线 3069 交付索引

候选 `9a58b707` 经 review-4 PASS 后 merge 到 main（`097d4215`），从 main 重新分配版本并重建产物（`e1075925`，`0.1.3.3069` / `versionCode 1100030690`）；原始记录保留在本地 ignored 目录 `android/evidence/rwd-geometry-gesture-0920-main-3069/replay.txt`。

- daemon：从 main 重建 `~/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs`（sha256 `89cf83ba9e0c9c26d0b58d7ceff0ad1d156823293bc0837ed15b3ec562a958aa`），`launchctl kickstart -k gui/<uid>/com.zterm.android.zterm-daemon` 后 PID 由 1758 变为 71243，`/health` `ok=true`，运行态确认加载新 binary。
- APK/OTA：`app-debug.apk` sha256 `da63181ca3691b230a29d0c680170b72c84e59b9cda6f777c7c9042cf40c4e27`；`~/.zterm/updates/latest.json` 指向 `0.1.3.3069`（同 sha256，size 6879395，rollback `0.1.3.3069.1` `497c495c...`）；`verify-update-bundle.mjs` `ok=true` 全绿；Tailscale `http://100.66.1.82:3333/updates/latest.json` 可达、APK GET `http=200 size=6879395`。
- 设备身份：15t `100.104.163.65:5555`（PLZ110）安装 `0.1.3.3069`，`firstInstallTime 2026-09-18 12:20:15` 保留，安装态 APK sha256 `da63181c...` 与 host 完全一致。
- 最终产物复测（真实 `zterm-3` → Finder `app-window:29243:37285`，解码视频 `readyState 4`、`987x719`、`currentTime` 推进）：A 缩放后全屏单指真实 swipe 后 rect `dx=dy=dw=dh=0` 且远端输入 0；B 真实双击后 rect 不变；C 双指同向产生 9 条 `remote-window-input`（`kind=scroll`，start+8 update）；D pinch out 精确还原 `{8,239,331,515}`；E 1x 单击恰好 1 条 `kind=click`/`button=left`；F 工具栏「缩小」`fullscreen→floating`、「关闭」使 overlay 与 bottom sheet 同时消失，无需杀 App。全部 PASS。
- 观测层与限制：远端输入在真实传输边界（`Capacitor.nativePromise`/`toNative`，plugin `AndroidConnectionService`）取证；adb tap 在无关 `com.oplus.ota` 窗口抢占输入焦点期间不达 WebView，故 1x 单击与两个工具栏点击改由 CDP touch 驱动（仍走真实 pointer runtime），A/B 使用真实 `adb shell input`。
