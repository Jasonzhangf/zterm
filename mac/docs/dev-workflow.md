# zterm Mac Dev Workflow

## 总原则

- 先冻结真源，再改实现
- Mac 只补平台壳，不另起 terminal 真相
- 先切入口 ownership，再切 deeper runtime
- 无运行态证据，不向 Jason 宣称“可以手测完整版”

## 标准流程

```text
Review truth
-> Freeze docs/task/cache
-> Cut minimal shell slice
-> type-check
-> build
-> packaged smoke（按需）
-> Evidence
```

## 本轮 rewrite 门禁

### 1. 文档门禁

先同步：

- `mac/docs/spec.md`
- `mac/docs/architecture.md`
- `mac/docs/dev-workflow.md`
- `mac/task.md`
- `mac/CACHE.md`

### 2. 代码门禁

本轮只允许做：

- App 入口切换
- shell ownership 重建
- launcher / editor / active tab 最小闭环
- 与真实 runtime 的薄适配

本轮不允许顺手做：

- split closeout
- local tmux closeout
- runtime 协议大杂烩式补丁

### 3. 验证门禁

最低静态门槛：

```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

若改到 Electron shell / packaged 行为，再补：

```bash
pnpm --filter @zterm/mac package
```

## 证据要求

至少给出：

- 改动文件
- type-check 输出
- build 输出
- 若未做 packaged smoke，必须明确写“本轮仅完成静态闭环”

## 汇报要求

本轮只能按真实范围汇报：

- 已切掉旧入口没有
- 新 app shell 是否接上真实 runtime
- 还没切掉的旧 runtime / buffer worker 在哪
- 下一刀准备切什么
