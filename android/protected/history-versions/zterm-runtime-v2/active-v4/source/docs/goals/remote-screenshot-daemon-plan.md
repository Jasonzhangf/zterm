# Remote Screenshot Daemon Implementation Plan

## 目标与验收标准

目标：把 remote screenshot 的权限申请与截图执行能力收敛到 `zterm-daemon` 安装态与运行态；安装完成后 Android 可长期通过 daemon 截图，不依赖本地 Codex Mac app、ZTerm Mac GUI helper 或任何 helper socket 进程。

验收标准：

- `zterm-daemon install-service` 是 macOS 截图权限预检 / 授权触发入口。
- daemon 是 remote screenshot 的唯一执行主体。
- Android 协议保持 `remote-screenshot-request -> remote-screenshot-status -> file-download-*` 不变。
- 用户错误文案只指向 daemon 权限 / 显示器 / 平台问题，不再出现 helper/socket/Codex Mac app。
- 源码脚本与 release/global daemon 脚本行为一致。
- 黑盒红测 `src/server/remote-screenshot-daemon-blackbox.test.ts` 转绿。

## 范围与边界

In scope：

- 重写 remote screenshot 文档真源。
- 删除 helper socket 依赖与相关测试固化。
- 在 daemon runtime 内实现截图执行路径。
- 更新 install-service 权限 preflight 与 release 脚本生成逻辑。
- 更新错误映射、file-transfer truth tests、最小运行态 smoke 证据。

Out of scope：

- 不改 Android preview/save 协议与 UI 主流程，除非文案必须改。
- 不引入第二条 fallback 截图路径。
- 不把 Codex Mac app / ZTerm Mac GUI helper 作为依赖。
- 不改 terminal buffer / renderer / session transport 语义。

## 设计原则

- 唯一真源：daemon install/runtime 拥有截图 capability，helper socket 设计必须物理移除或废弃。
- 无 fallback：截图失败必须显式报错，不回退到 helper、shell、另一个进程或静默 loading。
- 协议稳定：Android client 只看已有状态与文件下载流。
- 先红测后实现：先保留并运行黑盒红测确认失败，再逐项实现直到转绿。
- 打包一致：源码 `zterm-daemon.sh` 与 `prepare-global-daemon-release.sh` 输出的全局脚本必须同等支持权限 preflight。

## 技术方案与文件清单

文档：

- `android/docs/remote-screenshot-daemon-blackbox-regression.md`：黑盒契约真源。
- `android/docs/architecture.md`：Remote screenshot 链路改为 `Android client -> daemon -> macOS screenshot truth`。
- `android/docs/decisions/2026-04-28-remote-screenshot-helper-truth.md`：改为废弃说明或替换为 daemon truth，禁止继续声明 helper 是唯一执行主体。
- `android/MEMORY.md`：实现验证后追加已验证结论。

服务端：

- `android/src/server/terminal-file-transfer-list-runtime.ts`：`handleRemoteScreenshotRequest` 改走 daemon 内部截图 executor。
- `android/src/server/remote-screenshot.ts`：保留错误映射，但文案改为 daemon 权限/显示器/平台语义。
- `android/src/server/remote-screenshot-helper-client.ts`：删除或从生产路径物理移除。
- `android/src/server/terminal-file-transfer-types.ts`：如需要，补 daemon 截图 executor 依赖类型。
- `android/src/server/server.ts`：只注入底层 OS/FS 依赖，不承载业务真相。

安装 / 打包：

- `android/scripts/zterm-daemon.sh`：`install-service` 在 `bootstrap_service` 前执行截图 preflight；文案不再说权限属于 helper。
- `android/scripts/prepare-global-daemon-release.sh`：同步生成同一套 preflight 与 install-service 顺序。
- `android/src/server/daemon-service-script.test.ts`：覆盖源码脚本权限 preflight。

测试：

- `android/src/server/remote-screenshot-daemon-blackbox.test.ts`：必须从 5 个失败转为全绿。
- `android/src/server/server.file-transfer-truth.test.ts`：删除旧 socket-client 断言，改断言 daemon executor。
- `android/src/server/remote-screenshot.test.ts`：文案改为 daemon 语义。
- `android/src/server/remote-screenshot-helper-client.test.ts`：删除或替换为 daemon executor 测试。
- `android/src/pages/TerminalPage.remote-screenshot.test.tsx`、`android/src/contexts/SessionContext.ws-refresh.test.tsx`：保持 Android 协议与 preview/save 流程不变。

## 风险与规避

- macOS TCC 身份风险：必须用安装态 daemon runtime 的真实进程身份触发/验证权限，不用测试假象代替。
- macOS TCC 重复授权风险：源码安装态不得每次 `install-service` 都重编 `zterm-daemon` 原生二进制；只有缺失或源码更新才重建，否则会让系统把权限主体当成新二进制重新确认。
- launchd 上下文风险：实现后必须做真实 `install-service` 与 Android smoke，不只跑 unit。
- release 漏同步风险：源码脚本与 `prepare-global-daemon-release.sh` 必须同时改并有测试覆盖。
- 旧 socket-client 残留风险：生产路径不得再出现旧截图 IPC client、旧 socket 名或启动独立 Mac app 的指引。
- 工作区风险：当前仓库存在 `android/note.md` unmerged 与其他用户改动，实现时不得覆盖无关文件。

## 测试计划

先跑红测：

- `pnpm --dir android exec vitest run src/server/remote-screenshot-daemon-blackbox.test.ts --reporter dot`

定向转绿：

- `pnpm --dir android exec vitest run src/server/remote-screenshot-daemon-blackbox.test.ts src/server/remote-screenshot.test.ts src/server/daemon-service-script.test.ts src/server/server.file-transfer-truth.test.ts --reporter dot`
- 如删除 helper 测试，确保 package scripts 不再引用不存在文件。

协议回归：

- `pnpm --dir android exec vitest run src/pages/TerminalPage.remote-screenshot.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot`

构建 / 静态：

- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`

真实安装态 smoke：

- `pnpm --dir android daemon:install-service`
- `pnpm --dir android daemon:service-status`
- 不启动任何 Mac GUI helper / Codex Mac app，从 Android 发起 remote screenshot，保存截图、daemon 日志、Android 预览证据。
- 拒绝或撤销截图权限后，再发起 remote screenshot，确认错误文案指向 daemon 权限修复。

## 实施步骤

1. 确认工作区状态，保护已有未合并/用户改动。
2. 运行黑盒红测，记录 5 个失败作为基线。
3. 更新 architecture / decision 文档，废弃 helper 真源。
4. 改测试门禁：file-transfer truth、remote-screenshot 文案、daemon-service、release preflight。
5. 实现 daemon 内部截图 executor，替换 helper socket 调用。
6. 删除 helper client 与旧 helper tests / 文案残留。
7. 同步 `zterm-daemon.sh` 与 release 脚本权限 preflight。
8. 跑定向测试、协议回归、tsc。
9. 做真实 install-service + Android remote screenshot smoke。
10. 将已验证结论追加到 `android/MEMORY.md`，最终 summary 给出唯一性说明。

## 完成定义

- 黑盒测试、定向服务端测试、Android remote screenshot 协议测试全部通过。
- `rg` 证明生产路径没有 helper socket / Mac helper 指引残留。
- 安装态 daemon 不依赖 Codex Mac app / GUI helper 即可截图。
- release/global daemon 脚本与源码脚本一致。
- summary 包含：改了什么、验证证据、剩余风险、为什么 daemon runtime 是唯一正确修改点。
