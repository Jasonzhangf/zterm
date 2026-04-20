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
