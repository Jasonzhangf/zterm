# zterm Mac

Mac 客户端当前阶段先做 **最小可执行包**：

- Electron 主进程
- Vite + React 渲染进程
- 单行多列 + 垂直分屏 stage
- 可打包 `.app`

## 真源

- `docs/spec.md`
- `docs/architecture.md`
- `docs/dev-workflow.md`
- `MEMORY.md`
- `evidence/`

## 当前目标

先证明：

1. 可构建
2. 可打包
3. 可打开窗口
4. 可展示统一布局 stage

后续再逐步接入共享页面与功能。

## Commands

```bash
pnpm install
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
pnpm --filter @zterm/mac package
```
