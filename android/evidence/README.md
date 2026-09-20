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

- Base：`897040f7`；当前 review candidate 的 SHA 由本轮 review/delivery 记录
- 本地 focused：`session-context-buffer-runtime.test.ts` 72/72 PASS；`tsc --noEmit` PASS；`prebuild` 38 gates PASS
- daemon/tmux close loop：`android/evidence/daemon-mirror/2026-09-20/`，9/9 real cases PASS，`strict-audit.json` `ok=true`
- exact APK + emulator replay：`android/evidence/bug-8fdaeec-foreground-refresh-main-0919-r4/` 与 `-r5/`
- replay result：后台 tmux 写入 marker，HOT foreground resume 后 CDP DOM `containsMarker=true`，active session 未切换；tmux oracle、daemon health、logcat、APK SHA256 与进程/Activity 快照均在上述目录
