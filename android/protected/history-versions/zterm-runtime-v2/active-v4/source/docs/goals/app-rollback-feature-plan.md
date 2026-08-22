# App Rollback Feature — 实现计划

## 目标与验收标准

### 目标
为 zterm Android 客户端实现应用回滚功能：
1. 升级前自动将当前版本 APK 备份到本地 storage
2. 用户可在 Settings 页面主动回滚到上一版本

### 验收标准
1. 升级前 `startUpdate()` 调用 `backupCurrentApk()`，将当前 APK 备份到 `filesDir/rollback/` 目录
2. 备份成功后才继续下载/安装新版本；备份失败则 abort，提示用户
3. `AppUpdatePreferences` 新增 `rollbackBackup` 字段（含 versionCode/versionName/filePath/sha256）
4. Settings UI 在有备份时显示"回退到上一版本"按钮
5. 回滚时调用 `rollbackToBackup()`，用 FileProvider 调起系统安装
6. 回滚成功后清除 `rollbackBackup` 字段
7. 回滚按钮只在 `rollbackBackup !== null` 时显示
8. 所有 app-update 相关测试通过
9. `pnpm --dir android exec tsc --noEmit` 通过

## 范围

### In Scope
- native 层：新增 `backupCurrentApk()` / `rollbackToBackup()` / `getRollbackBackupInfo()` 三个 plugin 方法
- native 层：更新 `file_paths.xml`，添加 backup 目录的 FileProvider 路径
- Type 层：`AppUpdatePlugin` 接口扩展、`app-update.ts` 新增 `AppUpdateRollbackBackup` 接口和 `AppUpdatePreferences` 扩展
- Runtime 层：`app-update-runtime.ts` 新增 rollback 相关操作
- Hook 层：`useAppUpdate.ts` 暴露 rollback 状态和操作
- UI 层：`AppUpdateSection.tsx` 新增 rollback button，`App.tsx` 接入 rollback handler

### Out of Scope
- 多版本历史保留（只保留一个备份）
- 跨 channel 备份（只备份当前 channel）
- 备份文件加密
- 备份到 external storage / SDCard

## 设计原则

- 最小改动：复用现有 `AppUpdatePlugin` 框架，只新增方法，不改已有 install 流程
- 唯一真源：rollback backup 信息只在 `AppUpdatePreferences` 里存储一份
- 禁止 fallback：备份失败必须 abort upgrade，不静默跳过
- 验证优先：每步操作都有 error callback，不吞异常

## 技术方案

### 1. Native 层

#### 1.1 AppUpdatePlugin.java 新增方法

**`backupCurrentApk(): Promise<RollbackBackupInfo>`**
- 获取当前安装 APK 路径：`getContext().getPackageCodePath()`
- 创建 backup 目录：`filesDir/rollback/`
- 复制 APK 到 backup 目录：`rollback-{versionCode}-{timestamp}.apk`
- 计算备份 SHA256
- 返回：`{ versionCode, versionName, filePath, sha256 }`

**`rollbackToBackup(options: { filePath, sha256? }): Promise<void>`**
- 验证文件存在
- 校验 SHA256（若提供）
- 调起系统安装 intent（通过 FileProvider）

**`getRollbackBackupInfo(): Promise<RollbackBackupInfo | null>`**
- 读取 backup 目录，返回最新备份信息（若无则 null）

#### 1.2 file_paths.xml 更新

新增：
```xml
<files-path name="rollback_apk" path="rollback/" />
```

### 2. Type 层

#### 2.1 AppUpdatePlugin.ts 扩展

```typescript
export interface RollbackBackupInfo {
  versionCode: number;
  versionName: string;
  filePath: string;
  sha256: string;
  backedUpAt: number;
}

export interface AppUpdatePlugin {
  canRequestPackageInstalls(): Promise<{ allowed: boolean }>;
  openInstallPermissionSettings(): Promise<void>;
  downloadAndInstall(options: DownloadAndInstallOptions): Promise<{
    filePath: string;
    sha256: string;
    packageName?: string;
  }>;
  backupCurrentApk(): Promise<RollbackBackupInfo>;
  rollbackToBackup(options: { filePath: string; sha256?: string }): Promise<void>;
  getRollbackBackupInfo(): Promise<RollbackBackupInfo | null>;
}
```

#### 2.2 app-update.ts 扩展

```typescript
export interface AppUpdateRollbackBackup {
  versionCode: number;
  versionName: string;
  filePath: string;
  sha256: string;
  backedUpAt: number;
}

export interface AppUpdatePreferences {
  // ... existing fields
  rollbackBackup?: AppUpdateRollbackBackup | null;
}
```

### 3. Runtime 层

#### 3.1 AppUpdateRuntimeSnapshot 扩展

```typescript
export interface AppUpdateRuntimeSnapshot {
  // ... existing fields
  rollbackBackup: AppUpdateRollbackBackup | null;
  isBackingUp: boolean;
  isRollingBack: boolean;
}
```

#### 3.2 AppUpdateRuntimeDeps 扩展

```typescript
export interface AppUpdateRuntimeDeps {
  // ... existing deps
  backupCurrentApk: () => Promise<AppUpdateRollbackBackup>;
  rollbackToBackup: (options: { filePath: string; sha256?: string }) => Promise<void>;
  getRollbackBackupInfo: () => Promise<AppUpdateRollbackBackup | null>;
}
```

#### 3.3 新增 runtime 方法

```typescript
async startUpdate(manifest?): Promise<boolean> {
  // 现有逻辑之前新增：
  // 1. 调 deps.backupCurrentApk() 备份当前 APK
  // 2. 备份成功后才继续现有 download/install 逻辑
  // 3. 备份信息存入 snapshot.rollbackBackup
}

async rollbackToPreviousVersion(): Promise<boolean> {
  // 1. 检查 snapshot.rollbackBackup 不为 null
  // 2. 调 deps.rollbackToBackup({ filePath, sha256 })
  // 3. 回滚成功后清除 snapshot.rollbackBackup
}

restorePreferences() {
  // 1. 恢复 preferences（含 rollbackBackup）
  // 2. 调 deps.getRollbackBackupInfo() 校验备份文件是否仍存在
  // 3. 若文件不存在，清除 snapshot.rollbackBackup
}
```

### 4. Hook 层

新增返回值：
```typescript
const {
  rollbackBackup,
  isBackingUp,
  isRollingBack,
  rollbackToPreviousVersion,
} = useAppUpdate();
```

### 5. UI 层

#### 5.1 AppUpdateSection 新增

```tsx
// Props 新增
rollbackBackup?: AppUpdateRollbackBackup | null;
isBackingUp?: boolean;
isRollingBack?: boolean;
onRollback?: () => void;

// JSX 新增（只在该版本有备份时渲染）
{rollbackBackup && (
  <button onClick={onRollback} disabled={isRollingBack}>
    {isRollingBack ? '正在回滚…' : '回退到上一版本'}
  </button>
)}
```

#### 5.2 App.tsx 接线

- `rollbackBackup` → AppUpdateSection
- `isRollingBack` → AppUpdateSection
- `onRollback={() => rollbackToPreviousVersion()}` → AppUpdateSection

## 目标文件清单

### 新增文件
无

### 修改文件
1. `android/src/plugins/AppUpdatePlugin.ts` — 扩展 plugin 接口
2. `android/src/lib/app-update.ts` — 扩展 types
3. `android/src/lib/app-update-runtime.ts` — 扩展 runtime
4. `android/src/hooks/useAppUpdate.ts` — 暴露 rollback 状态
5. `android/src/components/settings/AppUpdateSection.tsx` — 新增 rollback button
6. `android/src/App.tsx` — 接线
7. `android/native/android/app/src/main/java/com/zterm/android/AppUpdatePlugin.java` — native 实现
8. `android/native/android/app/src/main/res/xml/file_paths.xml` — 新增 backup 路径

### 测试文件
1. `android/src/lib/app-update-runtime.test.ts` — 新增 rollback 测试
2. `android/src/hooks/useAppUpdate.test.tsx` — 新增 rollback hook 测试
3. `android/src/components/settings/AppUpdateSection.test.tsx` — 新增 rollback UI 测试

## 测试计划

### 必须执行
```bash
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

```bash
pnpm --dir android exec vitest run \
  src/lib/app-update-runtime.test.ts \
  src/hooks/useAppUpdate.test.tsx \
  src/components/settings/AppUpdateSection.test.tsx \
  --reporter dot
```

### 新增测试场景

#### app-update-runtime.test.ts
1. `startUpdate()` 调用 `backupCurrentApk()` 后才执行 `downloadAndInstall()`
2. `backupCurrentApk()` 失败时 `startUpdate()` 返回 false，不继续安装
3. `rollbackBackup` 在 backup 成功后写入 snapshot
4. `rollbackToPreviousVersion()` 调用 `rollbackToBackup()` 并清除 `rollbackBackup`
5. `restorePreferences()` 在 backup 文件不存在时清除 `rollbackBackup`

#### AppUpdateSection.test.tsx
1. `rollbackBackup !== null` 时显示"回退到上一版本"按钮
2. `rollbackBackup === null` 时不显示该按钮
3. 点击按钮调用 `onRollback`
4. `isRollingBack === true` 时按钮文案变为"正在回滚…"，按钮 disabled

## 风险与规避

| 风险 | 规避 |
|------|------|
| `getPackageCodePath()` 返回空或权限不足 | native try/catch，返回明确错误信息 |
| 备份文件被用户手动删除 | `restorePreferences()` 时校验文件存在性，不存在则清除 `rollbackBackup` |
| 备份消耗过多存储 | 只保留一个备份，新备份前先删除旧备份 |
| 回滚后 app 版本仍相同（用户反复升级/降级） | 接受；用户可重复操作，backup info 每次 upgrade 时更新 |

## 实施步骤

### Phase 1：Type 层 + Native 接口 + FileProvider
1. 更新 `file_paths.xml`
2. 更新 `AppUpdatePlugin.ts` 接口
3. 更新 `app-update.ts` 新增 type
4. 更新 `app-update-runtime.ts` 新增 types
5. `tsc` 验证

### Phase 2：Native 实现
1. 实现 `AppUpdatePlugin.java` 三个新方法
2. 编译验证

### Phase 3：Runtime + Hook
1. 更新 `app-update-runtime.ts` 新增 runtime 方法
2. 更新 `useAppUpdate.ts` 暴露新状态
3. `tsc` + targeted tests 验证

### Phase 4：UI 接线
1. 更新 `AppUpdateSection.tsx` 新增 rollback button
2. 更新 `App.tsx` 接线
3. `tsc` 验证

### Phase 5：测试
1. 补 app-update-runtime rollback 测试
2. 补 useAppUpdate rollback 测试
3. 补 AppUpdateSection rollback 测试
4. 全量 targeted tests 验证

## 完成定义（DoD）

同时满足：
- `tsc --noEmit` 全绿
- 所有 app-update 相关 tests 全绿
- `rollbackBackup` 数据流完整：backup → storage → UI → rollback → clear
- rollback button 只在有备份时显示
- 回滚后 `rollbackBackup` 被清除
- 总结里能说明为什么这套 rollback 方案是唯一正确的
