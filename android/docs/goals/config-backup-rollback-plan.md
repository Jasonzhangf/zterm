# Config Backup Rollback Plan

## 目标
- 正式回退链路改为：导出配置 -> 卸载当前版本 -> 安装旧版 -> 从固定备份恢复配置。

## 唯一 owner
- 备份/恢复状态机：`src/lib/app-config-backup-runtime.ts`
- 存储键 allowlist 与 payload contract：`src/lib/app-config-backup.ts`
- Android 外部存储接线：`src/hooks/useAppConfigBackup.ts`

## 生命周期
1. 显式点击“导出配置”
2. 请求外部存储权限
3. 将 allowlist localStorage 原样写入固定 JSON 文件
4. 显式点击“从备份恢复”
5. 读取 JSON，校验 schema，重写 allowlist，删除备份中缺失的 allowlist key
6. 触发整 app reload，让 mount-time storage hooks 重新取真相

## 红测
- 正向：导出成功写固定路径；恢复成功重写 allowlist 并 reload
- 反向：权限拒绝时不写文件；非法备份文件不改 storage、不 reload
