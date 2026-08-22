# Daemon + Relay Global Release Plan

## 目标与验收标准

目标：把 Mac daemon 的 npm 全局安装、relay 配置、真实双机上线验证，以及 Claw relay server 的发行形态收敛成可重复发布流程。

验收标准：
- `@jsonstudio/zterm-daemon` npm 包安装后可直接使用 `zterm-daemon configure-relay` 配置 relay。
- npm packed tarball 保留安装态必需 runtime native 依赖：`node-pty`、`@roamhq/wrtc`、`@roamhq/wrtc-<platform>-<arch>/wrtc.node`。
- Mac Studio 与 MacBook Air 均可通过 npm 全局包安装/升级后，在同一 relay 测试账号下同时在线。
- 强制 TURN relay-only RTC 对两台真实 daemon 均通过，local candidate type 为 `relay`。
- relay server 发行方案明确：独立 npm 包或 Docker/systemd 包，不混入 Mac daemon 包。

## 范围与边界

In Scope：
- 审计并修复 `android/scripts/prepare-daemon-npm-package.mjs`。
- 更新 daemon npm README 与 GitHub release note 中的全局安装、`configure-relay`、secret/stdin 配置流程。
- 增加 release verification，确保 npm tarball 包含 native runtime 依赖与 relay 配置命令。
- 用本地 packed tarball 在 MacBook Air / Mac Studio 做真实 `npm install -g <tgz>` 验证。
- 设计 relay server 独立发行包结构与验证门禁；必要时实现最小 package/deploy smoke。

Out of Scope：
- 不改 Android terminal renderer/buffer 语义。
- 不把真实测试账号密码、TURN credential 写入仓库。
- 不把 relay server 与 Mac daemon 合并成同一个 npm 包。
- 不做 fallback/降级路径；安装态失败必须暴露并修发行真源。
- 只有在所有本地打包/校验完成、确实需要执行 `npm publish` 时才暂停等待 Jason 发布；发布完成后必须继续执行 npm registry 全局安装与真实双机 relay/TURN 验证。

## 设计原则

- daemon 尽量简单：只读取 `~/.wterm/config.json`，不承担账号登录 UX。
- 配置走发行入口：用户安装/升级只使用 npm 全局包或 standalone release，不依赖手工改散落配置。
- 客户端驱动升级：Android UI/文档负责引导用户复制安装与配置命令。
- server 独立发行：Claw relay server 是公网控制面服务，应有自己的包、env contract 与部署验证。
- 红测优先：先用 failing tests 证明 npm 包/发行包缺口，再修复，再真实安装验证。

## 技术方案与文件清单

关键文件：
- `android/scripts/prepare-daemon-npm-package.mjs`
- `android/scripts/prepare-global-daemon-release.sh`
- `android/scripts/verify-release-assets.mjs`
- `android/scripts/publish-github-release.sh`
- `android/src/server/daemon-service-script.test.ts`
- `android/docs/relay-account-turn-verification-plan.md`
- `.agents/skills/zterm-mobile-dev/SKILL.md`

Daemon npm 包方案：
1. 保留 release staged runtime 的 `node_modules` 中安装态必需 native 依赖。
2. 在 npm README 增加：
   - `npm install -g @jsonstudio/zterm-daemon`
   - `zterm-daemon configure-relay --relay-url ... --username ... --password-stdin --host-id ...`
   - `zterm-daemon install-service|restart|service-status`
3. `verify-release-assets.mjs` 增加 tarball 内容检查，至少验证：
   - `support/zterm-daemon.sh` 存在 `configure-relay`
   - `runtime/node_modules/node-pty` 存在
   - `runtime/node_modules/@roamhq/wrtc` 存在
   - `runtime/node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node` 存在

Relay server 发行方案：
1. 新建独立包候选：`@jsonstudio/zterm-relay-server`，或 Docker image + systemd unit。
2. 只接受 env/secret 配置：relay base path、store path、TURN url/username/credential、listen host/port。
3. 提供 `zterm-relay-server health` 或 deploy smoke，验证 `/relay/health`、登录、WS endpoint、TURN payload。
4. Claw 部署使用 server 包，不依赖源码目录临时启动。

## 风险与规避

- 风险：npm 包删除 `runtime/node_modules` 导致安装态缺 native module。规避：tarball 内容测试 + MacBook Air 真安装验证。
- 风险：README/发布说明漏 `configure-relay`，用户仍手工改配置。规避：release note 与 README 统一到全局命令。
- 风险：relay server 与 daemon 包混杂。规避：包名与职责分离，server 只部署在 Claw。
- 风险：MacBook Air 非登录 shell PATH 找不到 node。规避：文档写明 npm global install 后用登录 shell 或 launchd runner 的 node 解析要求，并在真实安装验证中覆盖。

## 测试计划

红测：
- `daemon-service-script.test.ts` 增加 npm package tarball/package script gates：native runtime 依赖不能被删除，README 必须包含 `configure-relay`。
- `verify-release-assets` 增加 tarball 内容校验，先失败确认当前 npm 包缺 native deps。

绿测：
- `pnpm exec vitest run src/server/daemon-service-script.test.ts`
- `pnpm run daemon:prepare-release`
- `pnpm run daemon:prepare-npm`
- `pnpm run release:verify`

真实验证：
- Mac Studio：`npm install -g android/release-dist/jsonstudio-zterm-daemon-<version>.tgz`，执行 `configure-relay` 与 `restart/service-status`。
- MacBook Air：同上，通过 SSH 执行安装与配置。
- Relay API：同账号 `/api/devices` 同时看到 `mac-studio` 与 `macbook-air` online。
- TURN：两台均执行 relay-only RTC，local candidate type 为 `relay`。
- Evidence 落盘到 `android/evidence/relay-turn/YYYY-MM-DD/<run-id>/summary.json`。

## 实施步骤

1. 审计 npm package 与 release verify 当前缺口。
2. 写 npm packaging 红测并确认失败。
3. 修 `prepare-daemon-npm-package.mjs` 保留 native runtime 依赖。
4. 更新 README/release note/verification docs。
5. 构建 release + npm tarball，并通过 release verify。
6. 若本地 npm tarball 校验全部通过且下一步必须发布 npm 包，则暂停，明确给 Jason `npm publish` 命令、包名、版本与校验结果。
7. Jason 发布完成后，从 npm registry 执行真实 `npm install -g @jsonstudio/zterm-daemon`，不要用本地 tarball 代替最终验证。
8. 在 Mac Studio 与 MacBook Air 用 registry 全局包安装并配置 relay。
9. 验证同账号双 daemon online 与 TURN relay-only。
10. 设计并落文档：relay server 独立发行方案；若范围允许，实现最小 server package/deploy smoke。
11. 更新 `MEMORY.md` / skill / evidence。

## 完成定义

- npm 全局安装路径与 standalone release 路径行为一致。
- Jason 完成 npm 发布后，双机真实 registry npm 安装后 relay/TURN 验证通过。
- relay server 是否需要发行包有明确结论；若需要，已有独立包设计与下一步实现计划：`android/docs/goals/relay-server-release-plan.md`。
- 所有验证证据落盘，summary 汇报包含变更、验证、未完成项和风险。
