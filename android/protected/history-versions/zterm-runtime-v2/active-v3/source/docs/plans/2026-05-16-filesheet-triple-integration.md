# FileSheet 三合一实现

## 目标
将 FileTransferSheet（双向传输）、FileBrowserSheet（浏览+预览）整合为单个 FileSheet.tsx，三 Tab 切换，props 接口与原 FileTransferSheet 兼容。

## 交付物
1. `src/components/terminal/FileSheet.tsx`（新建，三 Tab 组件）
2. 更新 `TerminalPage.tsx` 导入，替换 FileTransferSheet 调用点
3. 删除 `FileTransferSheet.tsx`（功能已迁移）
4. 删除 `FileBrowserSheet.tsx`（功能已迁移）
5. 删除备份 `FileTransferSheet.tsx.bak`
6. TypeScript 零错误构建

## 三 Tab 功能详细说明

### Tab 1: 同步
- 左半屏：本地文件列表（从 ExternalStorage/Download/zterm 读取）
- 右半屏：远程文件列表（通过 fileTransferRuntime requestRemoteList）
- 传输方向切换按钮（下载/上传）
- 批量选择，多文件传输
- 传输进度列表
- **无预览功能**

### Tab 2: 发送
- 单列：本地文件列表（从 ExternalStorage 根目录读取，支持进入子目录）
- 选中文件后，点"发送"按钮
- 行为：上传到 host 的 ~/Downloads/zterm/ 目录
- 上传完成后：自动将完整路径写入系统剪贴板（navigator.clipboard.writeText），显示 toast 提示
- 路径格式：`file:///home/<user>/Downloads/zterm/<filename>`
- 用户通过系统粘贴（Cmd+V / Ctrl+V / 长按粘贴）使用

### Tab 3: 浏览
- 远程目录树导航（进入子目录、返回上级）
- 目录 breadcrumb 导航栏
- 文件列表：文件夹优先，显示大小和修改时间
- 文本文件：显示"预览"和"下载"两个按钮
- 非文本文件：只显示"下载"按钮
- 预览：下载到 CacheDirectory → UTF-8 读取 → 全屏展示（仅文本，>5MB 需确认）
- 下载：保存到 ExternalStorage/Downloads/zterm/

## 技术约束
- 同步 + 发送 共用一个 fileTransferRuntimeRef（都是 host 上传/下载）
- 浏览 使用独立的 previewRuntimeRef（列表+预览） + downloadRuntimeRef（下载）
- 不引入新 npm 依赖
- 复用现有 mobileTheme 样式
- Props 接口与原 FileTransferSheet 完全一致（open / remoteCwd / onClose / sendJson / onFileTransferMessage）

## 验证门禁
- [ ] TypeScript 零错误
- [ ] 代码分割后单 pane 功能正常
- [ ] 三 Tab 切换无卡顿
- [ ] 传输进度正常显示
- [ ] 预览仅支持文本，>5MB 弹窗确认
