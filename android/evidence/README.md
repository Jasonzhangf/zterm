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
- 当前 candidate 的设备/OTA replay：**未执行**（本机禁止触碰 tmux session）。因此当前 candidate 只有静态 + focused 层证据，L5 设备入口仍未验证。
