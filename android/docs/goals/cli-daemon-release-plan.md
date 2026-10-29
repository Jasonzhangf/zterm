# CLI 与 daemon release 执行计划

流程真源：[标准 release 流程](../decisions/2026-10-24-cli-daemon-release-process.md)。从零安装与空白机审计真源：[`docs/install-from-zero.md`](../../../docs/install-from-zero.md)。状态：M1–M3 公开 npm 发布与 GitHub Release `v0.1.3.3232` 已完成；真实空白机（物理机/空白 OS VM）端到端验证待空白机资源到位后执行。

## 本轮结果（2026-10-29）

- 基于 `origin/main`（`492650a074065b96d234167fa77f8d4bd2637d3f`）及 CI Run `40797381369` 三平台构建产物，`node android/scripts/verify-release-assets.mjs` 19 项校验全部通过（`ok: true`）。
- 已按顺序发布 5 个公开 npm 包并完成公开 registry 隔离 prefix 安装与 `zterm daemon install --version 0.1.3` 验收，随后提升 `latest` tag：
  - `@jsonstudio/zterm-daemon-darwin-arm64@0.1.3`（`shasum: c101e50f1c2b78e074e6bf2b413e26626c8cc5bb`，`latest: 0.1.3`，`next: 0.1.3`）
  - `@jsonstudio/zterm-daemon-linux-x64@0.1.3`（`shasum: edc1b1185b36858e11b5e18220a12243c0f31c29`，`latest: 0.1.3`，`next: 0.1.3`）
  - `@jsonstudio/zterm-daemon-win32-x64@0.1.3`（`shasum: f9598e400bc1760565be305f7e1587efbc738237`，`latest: 0.1.3`，`next: 0.1.3`）
  - `@jsonstudio/zterm-daemon@0.1.3`（`shasum: bcad7594e4f18cb17925f74659f93af71c0c3aeb`，`latest: 0.1.3`，`next: 0.1.3`）
  - `@jsonstudio/zterm-cli@0.1.4`（`shasum: 53ae4615c43e54585eb44f6913d34d314acf4b06`，`latest: 0.1.4`，`next: 0.1.4`）
- 已发布 GitHub Public Release [`v0.1.3.3232`](https://github.com/Jasonzhangf/zterm/releases/tag/v0.1.3.3232)，包含 `zterm-0.1.3.3232.apk`、回滚包 `zterm-0.1.3.3232.1.apk`、`latest.json`、`zterm-daemon-0.1.3-darwin-arm64.tar.gz`、5 个 npm `.tgz` 及其 `.sha256` 共 15 个可下载资产。
- 已与 AppSDK master（`Jenny`，`m1793238318673-416`）对齐版本兼容与安装顺序契约（`zterm-daemon` 固定要求 Node.js 22.x LTS `ABI 127`；共享 `TMUX_TMPDIR="$HOME/.tmux/run"`），沉淀于 [`docs/install-from-zero.md`](../../../docs/install-from-zero.md)。

## 仍保持 UNVERIFIED 的真实空白机缺口

- 真实空白机（无预装依赖的物理机或全新 OS VM）从零安装与升级/回滚验收：当前双项目均无可用空白机或空白账号（CI runner、容器及现有开发机不冒充空白机）。
- `Collab` 公开二进制分发与空白机安装顺序握手：`Collab` 当前仅提供源码安装脚本 `collab/scripts/install-global-collab.sh`，无公开预编译二进制或 npm 包，且在 Windows/WSL 与空白机上的顺序握手未验证。
- 跨机器 `Collab` 路由与双机联调：`cli-cross-machine-messaging` 仍在推进中，尚未在空白双机环境验证。

## 里程碑与依赖

| 工作项 | owner | 依赖 | 验收与停止条件 |
| --- | --- | --- | --- |
| M1：双机重装与流程设计 | 当前编排者；独立 Planner 提供方案 | 已合并 CLI 0.1.4 | 重装、入口、配置保留通过；流程、计划和历史入口对齐。只修改文档，不执行公开发布。 |
| M2：独立发布验证与 registry smoke | 后续执行 worker；编排者验收 | M1 | 按单元验证：CLI 一个 tarball，daemon 四个 tarball；联合发布可验证全部五包，无 Android APK 前置。registry 安装证明 home/prefix 隔离及三平台布局，错误不能投影成成功。 |
| M3：发布执行与渠道提升 | 获授权 release operator | M2，或完成等价的人工隔离验收；发布权限与兼容矩阵明确 | daemon payload→launcher；CLI 独立；next 验收后提升公开入口 latest。部分成功按单元记录，失败恢复实际 tag。 |

M2 优先复用 `verify-release-assets.mjs` 中的 daemon 校验与现有 `daemon-install-blackbox.mjs`，增加独立 CLI/daemon 入口和公开 registry 测试模式；不复制一套 verifier。先用缺包、错版本、跨平台 native 不匹配、未隔离全局 prefix 等具体反例取得红测，再实现。发布 workflow 的版本与通道输入、tag 恢复和人工发布权限属于该阶段实现范围，不能把本文中的设计当成现成命令。

M3 首次候选：daemon 0.1.3、CLI 0.1.4。先检查五个包的版本占用及 scope 权限，运行声明的 release gates，取得三平台产物。按流程完成两个独立发布单元，只有验证过的公开入口才提升 latest。新 CLI 依赖新 daemon 时，daemon 先提升。最后更新 README/wiki 的公开可用状态与简短 release notes。

## 执行前仍需明确

- 当前 npm 发布身份的实际 scope 权限或 trusted-publisher 配置。
- 候选版本是否可发布；CLI 0.1.4 × 公开 daemon 0.1.2 的实际能力及支持范围。
- 独立 verifier、公开 registry smoke、next/latest 发布与回滚流程的实现结果。

这三个缺口不影响本轮已完成的双机 tarball 重装。后续发布不得依赖测试账号秘密、用户 tmux 生命周期操作或生产 Relay 重启。
