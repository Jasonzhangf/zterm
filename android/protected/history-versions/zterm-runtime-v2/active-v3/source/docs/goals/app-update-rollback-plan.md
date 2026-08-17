# App Update Rollback — 实现计划与审计

- 日期：2026-05-25
- 范围：Android app 内升级与回退链路
- 目标：应用内升级前保留当前安装包一个版本；升级后允许用户回退到该旧版本

## 1. 用户需求

1. 升级包保留在本地，起码保留一个版本
2. 升级以后可以选择回退到旧版本

## 2. 当前实现结论

已实现全链路：

- TS runtime：保存 rollback backup 元信息、升级前先备份、支持回退动作
- React hook：暴露 rollbackBackup / isRollingBack / rollbackToPreviousVersion
- Settings UI：展示“回退到 <versionName>”按钮并触发回退
- Native Android plugin：
  - 备份当前安装 APK 到本地私有目录
  - 至少保留一个版本（当前策略：只保留最近一个备份）
  - 读取最近 rollback 备份信息
  - 校验 SHA-256 后调起安装进行回退

## 3. Owner 划分

### 3.1 Native owner
文件：`android/native/android/app/src/main/java/com/zterm/android/AppUpdatePlugin.java`

职责：
- 当前安装 APK 物理备份
- rollback 目录真相
- APK SHA-256 校验
- 安装 Intent 调起

这是唯一正确 owner，因为 APK 物理文件、包信息解析、安装权限、系统安装 Intent 都属于 Android 原生真相，JS 层不能伪造。

### 3.2 Runtime owner
文件：`android/src/lib/app-update-runtime.ts`

职责：
- update / rollback 流程状态机
- rollback backup 元数据持久化
- 升级前强制先备份
- 回退后清理 rollback backup

这是唯一正确 owner，因为升级/回退流程是应用业务状态机真相，UI 只消费，不应自己持有第二份流程语义。

### 3.3 Hook/UI owner
文件：
- `android/src/hooks/useAppUpdate.ts`
- `android/src/components/settings/AppUpdateSection.tsx`
- `android/src/pages/SettingsPage.tsx`
- `android/src/App.tsx`

职责：
- 将 runtime 投影为 UI 可消费状态
- 绑定“下载并安装 / 回退”按钮
- 不持有升级/回退业务真相

## 4. 实现细节

### 4.1 数据模型
文件：`android/src/lib/app-update.ts`

新增：
- `AppUpdateRollbackBackup`
- `AppUpdatePreferences.rollbackBackup`

字段：
- `versionCode`
- `versionName`
- `filePath`
- `sha256`
- `backedUpAt`

### 4.2 Runtime 流程
文件：`android/src/lib/app-update-runtime.ts`

升级流程：
1. 校验 target manifest
2. 校验 native 支持
3. `backupCurrentApk()` 备份当前安装包
4. 将 rollbackBackup 写入 preferences + snapshot
5. 检查安装权限
6. `downloadAndInstall()` 下载新包并调起安装
7. 安装流程发起成功后进入 `completed`

回退流程：
1. 读取 `snapshot.rollbackBackup`
2. 调用 `rollbackToBackup({ filePath, sha256 })`
3. 成功后清空 rollbackBackup
4. UI 不再显示回退按钮

### 4.3 Native 目录策略
文件：`AppUpdatePlugin.java`

- 升级下载：`cache/updates/`
- 回退备份：`files/rollback/`
- 当前策略：备份前先删除历史 rollback 备份，只保留最近一个版本

这个策略满足“起码保留一个版本”，且避免无限堆积旧 APK。

## 5. UI 行为

Settings / AppUpdateSection：
- 有新版本时可“下载并安装”
- 若存在 rollback backup，则展示：`回退到 <versionName>`
- 回退中按钮显示：`正在回滚…`

## 6. 测试与验证

### 6.1 已验证测试

```bash
pnpm --dir android exec vitest run src/lib/app-update-runtime.test.ts src/hooks/useAppUpdate.test.tsx src/components/settings/AppUpdateSection.test.tsx --reporter dot
```

覆盖：
- 升级前备份当前 APK
- 备份失败时中止升级
- 回退按钮显示与触发
- rollbackToPreviousVersion 成功后清理 backup
- useAppUpdate 正确暴露 rollback 状态与动作

### 6.2 已验证 TypeScript

```bash
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

### 6.3 后续设备验证

真实 Android 设备 smoke：
1. 安装旧版 A
2. 发现新版本 B 并触发升级
3. 确认 `files/rollback/` 中存在 A 的备份
4. 安装 B 后进入设置页，确认显示“回退到 A”
5. 触发回退，确认系统安装页打开且可安装回 A

## 7. 风险与边界

1. Android 系统安装页最终是否完成安装，不由应用内完全控制；应用只能保证调起、校验、提供合法 APK
2. 当前只保留一个 rollback 备份，这是有意设计，不保留多版本历史
3. rollback backup 元信息与实际文件若发生外部删除，回退会显式失败，不做 fallback

## 8. 唯一性说明

这次实现是唯一正确的实现方式：

- 物理 APK 备份只能由 native plugin 持有，因为只有 native 能读取当前安装 APK 与调起系统安装
- 升级/回退流程状态机只能由 `app-update-runtime.ts` 持有，因为 UI 只是投影，不能再持有第二份业务真相
- rollback 按钮只能消费 runtime 暴露的 rollbackBackup，而不能自己推断旧版本存在与否，否则会制造双真源

因此，`native backup/install truth + runtime flow truth + UI projection` 是唯一正确的 owner 划分。
