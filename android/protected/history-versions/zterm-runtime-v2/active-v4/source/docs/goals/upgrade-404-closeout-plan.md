# App Update 404 关闭方案

- 日期：2026-06-22
- 范围：zterm Android 客户端 + zterm daemon 升级通道
- 现象：App 弹窗能读到 manifest，点击「立即升级」原生报 `下载升级包失败：HTTP 404`

## 1. 现场根因（已用证据收敛）

- `android/update-dist/latest.json` 与 `~/.wterm/updates/latest.json` 都指向 `zterm-0.1.3.1870.apk`，两侧 APK 都存在：
  - `node android/scripts/verify-update-bundle.mjs` -> `ok: true`
  - `curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1870.apk` -> 200
  - `curl -I http://100.66.1.82:3333/updates/zterm-0.1.3.1870.apk` -> 200
- daemon `/updates/<file>` 路由 (`src/server/terminal-http-runtime.ts::handleHttpRequest`) 通过 `resolveUpdateFilePath` 取 `basename(pathname)`，再用 `existsSync` 决定 404；目录与文件存在时必然不会 404。
- 因此 404 不会来自服务端文件缺失，必然来自客户端拼接出错的 URL 喂给 `HttpURLConnection`。

### 客户端拼 URL 的全部可能错点

1. `appUpdate-runtime.startUpdate` 在 `refreshing-manifest` 阶段会重新拉一次 `snapshot.preferences.manifestUrl`，并用 `new URL(payload.apkUrl, snapshot.preferences.manifestUrl)` 把相对路径变绝对。
2. 客户端 `preferences.manifestUrl` 来源顺序：
   - 用户在设置里手写保存
   - 登录 Relay 后由 `deriveRelayUpdateManifestUrl(wsHostUrl)` 派生（`App.tsx::effectiveManifestUrl` / `buildRelayInjectedAppUpdatePreferences`）
   - 否则为空
3. 当用户没有手写、且没有 Relay 注入时，客户端启动时 manifestUrl 是空字符串；首检会直接报「未配置升级 manifest URL」，不会走到 404。
4. 当用户通过 Relay 登录但 relay host 不暴露 HTTP `/updates/<file>`（或用户端网络无法直连该 host）时，HTTP 拉 manifest 仍可能 200（如果 relay HTTP 入口有反代），但 APK 下载 404。
5. 当用户在 WebView 仍保留旧的 `127.0.0.1:3333` 偏好（设备不能从 127.0.0.1 直接触达），APK 必然 404。
6. 当 manifest 里 `apkUrl` 是相对路径，且设备与 daemon 处在不同子网，HTTP Host 头是设备侧 IP，daemon 仍然从 `payload.apkUrl` 重算——但 `payload.apkUrl` 此时拼出来的绝对 URL 仍是用户偏好里的 manifestUrl 派生，host 是偏好里的 host。

## 2. 目标

- 客户端在 404 出现时**不再让用户猜**：把真正要下载的 manifestUrl、apkUrl、HTTP 状态码、文件 sha256 全部暴露到客户端 debug snapshot + Settings 弹层 + status 浮窗（如果开启）。
- 客户端拼 URL 必须走**单一真源**：`app-update-runtime` 是 manifest url 的唯一所有者；`App.tsx` 不再持第二份 `effectiveManifestUrl` 渲染。
- 升级链路必须在客户端持有 stale manifest / stale apkUrl 时显式失败，给出可重试的明确动作。
- 当 `HttpURLConnection` 抛出非 200 时，原生要明确把 `error.message`（含状态码）透回前端，并在 debug snapshot 中标记 `appUpdateLastInstallError` 字段。

## 3. 设计原则

- 单一真源：manifest URL 的来源/拼接/失败语义全部归 `app-update-runtime`；`App.tsx`/`Settings`/debug 只消费不派生。
- 失败暴露：HTTP 失败、URL 拼错、SHA-256 不匹配必须显式 `lastError`，不吞异常、不 fallback 到旧 host。
- 验证优先：所有路径变化必须有红测 + on-device evidence。
- 读写解耦：manifest url 写入走 `setPreferences`；读取走 `runtime.getSnapshot().preferences.manifestUrl`。任何 `effectiveManifestUrl` 这种「视图派生 host」必须标注 derivation chain。

## 4. 技术方案

### 4.1 客户端

#### 4.1.1 新增 owner：`app-update-runtime` 是 manifest URL / apk URL 唯一所有者
- 新增 helper `resolveInstallTarget({ preferredManifestUrl, currentApkContext })`：
  - 输入只有 `preferredManifestUrl` 和 `currentApkContext`（来自 session transport host）
  - 输出 `{ manifestUrl, apkUrl, source, derivationChain }`
  - `source` ∈ `user-saved | relay-injected | server-connected | fallback-error`
- 删掉 `App.tsx::effectiveManifestUrl`、`buildRelayInjectedAppUpdatePreferences` 在 App.tsx 的二次派生；统一改 `app-update-runtime` 内部派生。
- `checkForUpdates` / `startUpdate` 都通过 `resolveInstallTarget` 计算 `installTarget.apkUrl` 并把 `derivationChain` 写入 snapshot。
- `startUpdate` 在 `downloadAndInstall` 之前必须把 `installTarget.apkUrl` 写入 `snapshot.lastInstallContext`，供 debug / Settings 渲染。

#### 4.1.2 失败透传
- `app-update-runtime.startUpdate` catch 块里要保留 `error.message`（来自 `HttpURLConnection` 状态码），并把 `installTarget.apkUrl`、`installTarget.sha256`、`installTarget.manifestUrl` 一并写入 `snapshot.lastInstallContext`。
- `AppUpdatePlugin.downloadAndInstall` 在 IOException / `getResponseCode() >= 300` 时，错误 message 必须含 `HTTP <code>` + `URL: <url>`，便于客户端定位。

#### 4.1.3 Debug snapshot & Settings 暴露
- `app-shell` snapshot 增加字段：
  - `appUpdateManifestUrl`（runtime 内已规范化）
  - `appUpdateEffectiveManifestUrl`（含 derivation chain：user / relay / server / fallback）
  - `appUpdateLatestManifest.apkUrl`
  - `appUpdateAvailableManifest.apkUrl`
  - `appUpdateLastInstallError`
  - `appUpdateLastInstallContext`：`{ manifestUrl, apkUrl, httpStatus, sha256Expected, sha256Actual, time }`
- `AppUpdateSection` 在 `updateError` 下追加一个折叠的"诊断信息"行（仅当存在 lastInstallContext 时显示），把上面 4 个字段显示给用户，便于截屏。

#### 4.1.4 URL 拼接单测
- 红测：用户偏好 `http://100.66.1.82:3333/updates/latest.json`，manifest 内 `apkUrl` 是相对 `zterm-0.1.3.1870.apk`，运行时 `installTarget.apkUrl` 必须是 `http://100.66.1.82:3333/updates/zterm-0.1.3.1870.apk`（不允许走 `connected.appUpdate.manifestUrl` 的其它 host）。
- 红测：当 user-saved 为空 + relay-injected 存在，使用 relay host；不允许回到 127.0.0.1。
- 红测：当 user-saved 与 server-connected 存在冲突，记录 `derivationChain=server-connected` 但 `manifestUrl` 必须和 `user-saved` 一致才允许使用 server 提供的 apkUrl（同源才用）；不同源时显式 fail。

#### 4.1.5 Native 端 downloadAndInstall 错误透传
- `AppUpdatePlugin.java::downloadAndInstall`：
  - IOException / `getResponseCode() < 200 || >= 300`：message 改为 `下载升级包失败：HTTP <code> <reason> (URL: <url>)`
  - 已写出的临时文件要清理。

### 4.2 服务端

- 保留 `daemon /updates/<file>` 路由不变。
- `verify-update-bundle.mjs` 已经在发布前锁住两侧一致性；不动。

## 5. 文件清单

- `android/src/lib/app-update-runtime.ts`
- `android/src/lib/app-update-runtime.test.ts`（新增 owner / derivation chain / lastInstallContext 红测）
- `android/src/lib/app-update.ts`（扩展 `AppUpdatePreferences` / `AppUpdateSnapshot` 字段：lastInstallContext 等）
- `android/src/lib/app-update-relay-manifest.ts`（改为只产出 `derivationChain` 元数据，不再直接写 snapshot）
- `android/src/App.tsx`（删 effectiveManifestUrl 派生，直接消费 runtime snapshot；扩展 app-shell snapshot）
- `android/src/components/settings/AppUpdateSection.tsx`（增加诊断信息折叠行）
- `android/native/android/app/src/main/java/com/zterm/android/AppUpdatePlugin.java`（错误 message 增强）
- `android/docs/feature-registry.json`（owner / gate 更新）

## 6. 风险与规避

1. 用户偏好 host 与设备直连 host 不一致：客户端必须显式提示，不允许静默切换。
2. Relay 注入的 host 走 HTTPS 时证书自签会被 WebView 拒：本轮不动 TLS；新增的诊断信息会显示真实 `manifestUrl` 与 `apkUrl`，便于排查。
3. APK 拼错时 404 仍会发生：诊断信息显示 URL，用户能直接复制 host 与路径手动验证。

## 7. 验证矩阵

- 单测：
  - `npx vitest run src/lib/app-update-runtime.test.ts src/lib/app-update-relay-manifest.test.ts src/lib/app-update.test.ts src/hooks/useAppUpdate.test.tsx src/components/settings/AppUpdateSection.test.tsx`
- 整包：
  - `cd android && ./scripts/build-android-debug.sh`
- 发布后现场：
  - `node android/scripts/verify-update-bundle.mjs`
  - `curl -I http://127.0.0.1:3333/updates/zterm-<ver>.apk` -> 200
- 设备端：
  - 触发「检查更新」后 `appUpdateLatestManifest.apkUrl` 与「下载并安装」时 `lastInstallContext.apkUrl` 一致。
  - 失败时，AppUpdateSection 折叠诊断行显示真实 `manifestUrl` / `apkUrl` / `httpStatus`。

## 8. 实施步骤

1. 落盘 `AppUpdatePreferences.lastInstallContext` schema 并补单测。
2. 在 `app-update-runtime` 中新增 `resolveInstallTarget`，统一 APK URL 真源；删 `App.tsx::effectiveManifestUrl` 与 `App.tsx::buildRelayInjectedAppUpdatePreferences` 路径。
3. 扩展 app-shell debug snapshot 字段。
4. 扩展 `AppUpdateSection` 诊断折叠。
5. 改 `AppUpdatePlugin.java` 错误 message。
6. 跑 `vitest` + `tsc` + `build-android-debug.sh`。
7. `verify-update-bundle.mjs` + `curl` 现场核对。
8. 升级到新 APK 设备验证。

## 9. 完成定义

- `app-shell` snapshot 中能直接看到 `appUpdateManifestUrl / appUpdateLatestManifest.apkUrl / appUpdateLastInstallError`。
- 当 404 出现时，AppUpdateSection 折叠诊断行能展示 `manifestUrl / apkUrl / httpStatus / sha256Expected`。
- `npx tsc --noEmit` clean；`vitest` 全绿；新 APK 落到 `~/.wterm/updates/` 且 `verify-update-bundle.mjs` `ok: true`。
- 真机通过 `adb logcat | grep AppUpdatePlugin` 触发一次失败路径，可看到包含 `HTTP 404` 的 message。
