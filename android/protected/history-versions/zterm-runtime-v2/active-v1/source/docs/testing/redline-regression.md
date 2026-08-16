# Redline Regression Gate（红测→修复→绿测→真机）

## 强制顺序
1. 红测：先新增/调整测试，稳定复现问题（必须先失败）
2. 修复：仅改唯一真源
3. 绿测：同一测试转绿，防回归
4. 真机：仅做最终验收，不作为唯一验证手段

## 本地 daemon-mirror 回放 harness
- 真源测试：`src/lib/terminal-buffer-replay.evidence.test.ts`
- 数据来源：`evidence/daemon-mirror/replay-cases/*`
- 作用：本地回放 `buffer-sync` 历史，验证渲染结果与 tmux oracle 一致

## 4 条核心红线（必跑）
1. tab 持久化：`src/lib/open-tab-persistence.test.ts`
2. tab 恢复一致性：`src/lib/open-tab-restore.test.ts`
3. buffer-sync drop 门禁：`src/contexts/session-context-transport-runtime.test.ts`
4. 输入到达→本地刷新（回放证据）：`src/lib/terminal-buffer-replay.evidence.test.ts`

## 执行命令
```bash
pnpm test:redline:fast   # 开发阶段快速门禁
pnpm test:redline        # 提交前完整门禁（含 daemon-mirror 回放）
```

## CI 要求
- CI 必须执行 `pnpm test:redline`
- 任一 redline 失败，禁止发布 APK / 更新包
