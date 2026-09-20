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
- 当前 candidate 的 exact APK 设备回放（`0.1.3.3065` / `versionCode=1100030650` / APK sha256 `e3018af068d7d2877d46d579f46984e2dabc3e9c4b43009d0455773efa0cdb76`）：
  - 真机 `100.104.163.65:5555`：安装前后保留应用数据，HOME 后只切换 localhost mock payload，再回前台；active session 未切换，DOM 从 `MOCK_INITIAL_4F31A` 更新为同时包含 `MOCK_RESUME_7C92B`。
  - 模拟器 `emulator-5556`：同一 HOME -> 前台入口通过；active session id 保持不变，DOM 出现 `MOCK_RESUME_7C92B`。
  - 两次 mock summary 均为 `connections=1`、`closed=0`，证明恢复复用同一物理连接；mock 只监听 `127.0.0.1`，未创建、关闭、resize 或写入任何 tmux session。
  - incomplete frame owner gate：`session-context-buffer-runtime.test.ts` 的 staged body-first 与 retained multi-chunk 两条 timeout 测试 2/2 PASS，断言 15s lifetime 到期后请求精确 repair range `100-104`。
- exact-candidate 可复核索引：`android/evidence/bug-8fdaeec-fg-refresh-main-0919-exact-r1/`
- 当前 candidate 的 OTA/公开 Relay 发布：**未执行**（发布是独立授权阶段）；本机 update-dist 与 `~/.zterm/updates` 已对齐该 APK。
