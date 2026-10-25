# CLI 与 daemon release 执行计划

流程真源：[标准 release 流程](../decisions/2026-10-24-cli-daemon-release-process.md)。状态：流程已制定；自动化与公开发布待执行。本轮不调用 npm publish 或移动 tag。

## 本轮结果

- Mac Studio 和 MacBook Air 已从本轮 tarball 重装 CLI 0.1.4，正式入口均为 `/opt/homebrew/bin/zterm`；版本和 slot 帮助检查通过，共享配置保留。
- Air 的默认 Node 24 缺少动态库。已有 Node 22.23.4 可用，已通过 Homebrew link 恢复默认入口；RTC native 加载通过。没有服务重启。
- 公开 npm 查询返回 CLI E404、daemon `latest=0.1.2`。源码候选为 CLI 0.1.4 / daemon 0.1.3；最终版本须在发布前重新检查，不由 E404 推断版本可用。

## 里程碑与依赖

| 工作项 | owner | 依赖 | 验收与停止条件 |
| --- | --- | --- | --- |
| M1：双机重装与流程设计 | 当前编排者；独立 Planner 提供方案 | 已合并 CLI 0.1.4 | 重装、入口、配置保留通过；流程、计划和历史入口对齐。只修改文档，不执行公开发布。 |
| M2：独立发布验证与 registry smoke | 后续执行 worker；编排者验收 | M1 | CLI/daemon 五个 tarball 可独立验证，无 Android APK 前置；registry 安装证明 home/prefix 隔离及三平台布局，错误不能投影成成功。 |
| M3：发布执行与渠道提升 | 获授权 release operator | M2，或完成等价的人工隔离验收；发布权限与兼容矩阵明确 | daemon payload→launcher；CLI 独立；next 验收后提升公开入口 latest。部分成功按单元记录，失败恢复实际 tag。 |

M2 优先复用 `verify-release-assets.mjs` 中的 daemon 校验与现有 `daemon-install-blackbox.mjs`，增加独立 CLI/daemon 入口和公开 registry 测试模式；不复制一套 verifier。先用缺包、错版本、跨平台 native 不匹配、未隔离全局 prefix 等具体反例取得红测，再实现。发布 workflow 的版本与通道输入、tag 恢复和人工发布权限属于该阶段实现范围，不能把本文中的设计当成现成命令。

M3 首次候选：daemon 0.1.3、CLI 0.1.4。先检查五个包的版本占用及 scope 权限，运行声明的 release gates，取得三平台产物。按流程完成两个独立发布单元，只有验证过的公开入口才提升 latest。新 CLI 依赖新 daemon 时，daemon 先提升。最后更新 README/wiki 的公开可用状态与简短 release notes。

## 执行前仍需明确

- 当前 npm 发布身份的实际 scope 权限或 trusted-publisher 配置。
- 候选版本是否可发布；CLI 0.1.4 × 公开 daemon 0.1.2 的实际能力及支持范围。
- 独立 verifier、公开 registry smoke、next/latest 发布与回滚流程的实现结果。

这三个缺口不影响本轮已完成的双机 tarball 重装。后续发布不得依赖测试账号秘密、用户 tmux 生命周期操作或生产 Relay 重启。
