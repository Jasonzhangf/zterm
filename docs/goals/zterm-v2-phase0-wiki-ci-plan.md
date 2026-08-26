# Phase 0 Worker Plan: wiki review surface and CI scaffold

## 目标与验收标准

建立 v2 可点击架构 review 面和 CI/build 入口，使 phase manifest、maps、owner、edge、payload isolation、DAG gate 可被持续执行。

验收：HTML/Markdown/Mermaid review 面可离线打开；manifest 节点 ID 与图一致；CI/prebuild 至少真实调用 Phase 0 gates；失败 gate 返回非零。

## 范围与边界

In scope：`docs/architecture` review 面、Mermaid source、phase manifest 校验脚本/测试、CI/build 接线设计。

Out of scope：不改 runtime、不改 UI、不安装 Cordis、不接入未存在的生产 gate、不生成外部 CDN 依赖。

## 设计原则

review 面与机器 manifest 共用节点 ID；HTML deterministic/offline；CI 只调用真实 gate；未实现 gate 标 `pending/ungated`，不能虚报 required。

## 技术方案与文件清单

- manifest：`docs/architecture/zterm-cordis-v2-phase-manifest.json`
- 设计：`docs/design/2026-08-26-zterm-cordis-v2-cross-platform.md`
- 参考：`android/docs/wiki/`、`.github/workflows/ci.yml`、根/平台 package scripts
- 输出：`docs/architecture/wiki/` review 面、manifest validator、CI 接线变更

## 风险与规避

不把文档自洽当代码合规；不接入不存在的命令；不允许 CDN/script runtime；保持 CI 失败可观察。

## 测试计划

manifest parse；节点/边/文档引用完整性；offline HTML scan；validator 正反测试；CI dry-run 或实际最小 gate。

## 实施步骤

1. 读取现有 wiki/CI/build 入口。
2. 生成 v2 Mermaid/HTML/Markdown review surface。
3. 实现 manifest/review consistency validator。
4. 接入真实 CI/prebuild gate，验证失败路径。
5. 写 evidence 与 handoff。

## 完成定义

review 面可离线浏览、manifest 与图一致、CI 真跑 gate、失败可阻断；无 runtime 修改；clean worktree。
