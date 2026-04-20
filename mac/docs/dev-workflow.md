# zterm Mac Dev Workflow

## 总原则

- 先冻结真源，再写代码
- 先证明最小可执行包，再加功能
- 先验证构建/打包闭环，再扩展共享业务层

## 标准流程

```text
Review -> Freeze -> Implement -> Type-check -> Package -> Browser verify -> Quit old app -> Packaged-app smoke -> Evidence
```

## 本阶段验证入口

### L1 Type-check

- `pnpm --filter @zterm/mac type-check`

### L2 Build

- `pnpm --filter @zterm/mac build`

### L3 Package

- `pnpm --filter @zterm/mac package`

### L4 Browser verify renderer flow

- `pnpm --filter @zterm/mac dev`
- 打开 `http://127.0.0.1:5174/`
- 验证 Connections / Details / Terminal 三栏
- 验证 connection 表单保存后，列表 / terminal / remembered server 同步更新
- 验证 live bridge 主链：
  - `connect(payload)`
  - `stream-mode(active)`
  - terminal pane 出现 snapshot 文本
- 若使用本地 mock bridge 做验证，优先使用无敏感 token 的本地测试目标

### L5 Run packaged app

- 必须先退出旧的 `ZTerm` 实例，再打开生成的 `.app` 或 unpacked 包
- 确认窗口可见
- 确认 stage 为单行多列 + 垂直分屏
- 若需要重复验证，继续遵守“先 quit 旧实例，再 open 新包”，禁止叠多个 app 进程污染证据

## 证据要求

- type-check 输出
- build 输出
- package 输出
- 产物路径
- 浏览器交互验证证据
- live terminal render 证据
- bridge endpoint 归一证据（host 自带端口时不再重复拼 port）
- 必要时窗口截图
