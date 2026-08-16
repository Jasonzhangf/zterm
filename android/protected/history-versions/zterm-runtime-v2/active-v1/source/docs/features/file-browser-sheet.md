# 悬浮球文件浏览器

## 背景

在悬浮球快捷操作区增加「📁 浏览文件」按钮，点击后打开只读的文件浏览器。用户在 daemon 所在的远程机器上浏览当前 session 工作目录下的文件，可以进入子目录、返回上级、预览文本文件内容、下载任意文件到本地。

## 用户需求

- **入口**：悬浮球快捷操作区（inline toolbar）
- **只读**：仅浏览和下载，不支持上传或修改
- **导航**：子目录进入、上级返回、回到 session 根目录
- **预览**：仅文本文件（json/md/txt/toml 等），大文件（>5MB）提示用户
- **下载**：所有文件类型均可下载，保存到 `Downloads/zterm/` 目录
- **根目录**：默认为当前 session 的工作目录（tmux pane cwd）

## 支持的文本文件格式

```
txt, json, md, toml, yaml, yml, xml, html, htm, css, js, ts, tsx, jsx,
sh, bash, zsh, py, pyw, rb, go, rs, java, c, cpp, h, hpp, m, swift,
kt, gradle, properties, ini, cfg, conf, env, gitignore, gitconfig,
dockerfile, makefile, cmake, lua, php, pl, yaml, toml, log, md, rst,
v, vh, vhd, s, asm, nix, tf, tfvars, graphql, proto, mermaid, plantuml
```

## 不支持的文件

- 二进制文件（图片/视频/音频/压缩包/可执行文件）只能下载，不能预览
- 预览按钮对这些文件灰置禁用

## 文件大小限制

- **预览**：仅支持 ≤5MB 的文本文件，超过则弹窗提示"文件过大，是否继续？"
- **下载**：无限制

## 技术架构

### 组件

```
TerminalPage
  └── FileBrowserSheet (新建)
        ├── 文件列表区
        ├── 面包屑路径栏
        └── 预览/下载底部菜单
```

### 协议复用

daemon 已有完整的文件操作协议，FileBrowserSheet 直接复用：

| Client → Daemon | Daemon → Client |
|-----------------|-----------------|
| `file-list-request` | `file-list-response` |
| `file-download-request` | `file-download-chunk` + `file-download-complete` |

### 文件下载流程（复用现有逻辑）

```
1. Client 发 file-download-request { remotePath, fileName, requestId }
2. Daemon 分 chunk 返回 base64 数据
3. Client 组装完整 binary
4. 预览：写入 CacheDirectory → Browser.open()
5. 下载：写入 DownloadDirectory → toast 提示路径
```

### 预览实现

```
1. 识别 MIME 类型（扩展名判断）
2. 非文本格式 → 预览按钮禁用
3. 文本格式 + 文件 >5MB → 弹窗提示
4. 下载到 /data/data/<package>/cache/<file>
5. 调用 @capacitor/browser Browser.open() 打开
```

## Props 接口

```typescript
// FileBrowserSheet
interface FileBrowserSheetProps {
  open: boolean;
  remoteCwd: string;          // session 当前工作目录（根目录）
  sendJson: (msg: object) => void;
  onFileTransferMessage: (handler: (msg: any) => void) => () => void;
  onClose: () => void;
  activeSessionId: string | null;
}
```

## 文件路径传递链

```
App.tsx
  └── onOpenFileBrowser → TerminalPage
                            └── handleOpenFileBrowser → fileBrowserOpen=true
                                  └── <FileBrowserSheet open={fileBrowserOpen} ...>

TerminalQuickBar (inline toolbar)
  └── 📁 浏览文件 button
        └── onOpenFileBrowser()
```

## UI 设计

### FileBrowserSheet 布局

```
┌─────────────────────────────┐
│ ⌂  /home/user/project     ✕ │  ← 根目录 + 关闭
├─────────────────────────────┤
│ ‹  src/components          │  ← 上级 + 当前路径
├─────────────────────────────┤
│ 📁  terminal              │  ← 文件夹（可点击进入）
│ 📁  server
│ 📄  package.json    1.2KB │
│ 📄  tsconfig.json    0.8KB │
│ 📄  README.md       4.1KB │
│ 📄  screenshot.png  256KB │  ← 非文本，预览灰置
└─────────────────────────────┘
```

### 文件操作底部菜单

点击任意文件弹出：

```
┌─────────────────────────────┐
│  文件：README.md            │
├─────────────────────────────┤
│  📄 预览                    │  ← 文本文件可点击
│  ⬇️ 下载                   │
├─────────────────────────────┤
│  取消                      │
└─────────────────────────────┘
```

### 预览弹窗

```
┌─────────────────────────────┐
│ README.md              ✕     │
├─────────────────────────────┤
│ # My Project              │
│                           │
│ Lorem ipsum dolor sit...  │
│                           │
│ （支持滚动）                │
└─────────────────────────────┘
```

## 实现步骤

### Step 1: 新建 FileBrowserSheet.tsx

- 实现文件列表渲染
- 实现子目录导航逻辑
- 实现预览菜单和预览弹窗
- 实现下载逻辑
- 实现大文件提示

### Step 2: 打通快捷按钮 → Sheet 的传递链

- `TerminalQuickBar.tsx` props 新增 `onOpenFileBrowser`
- `TerminalPage.tsx` 新增 state 和 handler
- `App.tsx` 透传回调

### Step 3: 挂载组件

- `TerminalPage.tsx` JSX 中渲染 `<FileBrowserSheet>`

### Step 4: 测试验证

- 连接真实 daemon
- 手机上测试：浏览、进入子目录、返回上级、回到根目录
- 测试文本文件预览（txt/json/md）
- 测试大文件提示（构造 >5MB 文件）
- 测试非文本文件预览禁用

## 验收标准

1. 点击悬浮球「📁 浏览文件」按钮能打开 FileBrowserSheet
2. 文件列表正确显示当前 session 根目录内容
3. 点击文件夹能进入子目录
4. 点击 `‹` 能返回上级目录
5. 点击 `⌂` 能回到 session 根目录
6. 文本文件（txt/json/md/toml 等）可以预览
7. >5MB 文件预览前有确认提示
8. 非文本文件预览按钮灰置禁用
9. 任意文件可以下载到 `Downloads/zterm/` 目录
10. 下载成功有 toast 提示

## 预览实现方案

项目中未安装 `@capacitor/browser` 插件。预览采用内置 Modal 方案：

- `Filesystem.readFile()` 读取缓存文件内容（base64）
- 解码后在 React Modal 中直接渲染文本
- 大文件（>5MB）预览前弹窗确认

不依赖外部 Browser 插件，完全自包含。
