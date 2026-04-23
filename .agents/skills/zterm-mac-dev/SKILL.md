---
name: zterm-mac-dev
description: "zterm Mac 客户端开发工作流 - Electron 壳、terminal renderer、local/remote tmux、自闭环验证"
---

# zterm-mac Dev Skill

## 适用场景
- `mac/` 下的 Electron / renderer / preload / local tmux / remote bridge 开发
- Mac terminal 渲染、分屏、tab、local tmux、remote 连接、资源占用审计
- 用户要求先自测闭环、拿证据，再让 Jason 手测

---

## 一、必读顺序
1. `~/.codex/AGENTS.md`
2. `~/.codex/USER.md`
3. `coding-principals/SKILL.md`
4. `android/docs/decisions/0001-cross-platform-layout-profile.md`
5. `android/docs/architecture.md`
6. `android/docs/dev-workflow.md`
7. `mac/MEMORY.md`
8. 本 `SKILL.md`

---

## 二、Mac 开发硬规则

### 2.0 Skill 使用边界
- 本仓库 Mac 线默认只使用这一个项目 dev skill：`zterm-mac-dev`。
- 不要再为同一条 Mac 开发链路额外切换/串联新的本地 dev skill，避免规则分叉。
- 若确实需要别的 skill，必须是 Jason 显式点名。


### 2.1 Terminal / renderer
- renderer 只消费 canonical buffer / render projection；禁止在 view 层继续造第二份 terminal 真相。
- terminal 优先 terminal-first：少 chrome、少常驻面板、主空间给 terminal pane/tab/split。
- 分屏默认是一行多列、垂直分屏；不要把上下堆叠当主方案。
- reading/backfill 里 `missingRanges` 必须从 view -> runtime -> transport 原样透传；任一层清空它，scroll prefetch 都会静默失效。

### 2.2 连接 / tmux
- remote 连接与 local tmux 都必须走真实 runtime，不允许静态占位冒充 live terminal。
- “能列 session” 不等于 “已 attach”；需要真实 connect / attach / resize / input 路径验证。
- 修改 local tmux / remote bridge / renderer 任一层后，必须至少做一次实际 smoke，不只看编译通过。

### 2.3 资源与生命周期
- 不允许只凭代码阅读宣称“没有内存泄漏/没有孤儿进程”；必须有运行态证据。
- 旧 app 必须先退出，再打开新包；不要叠多个实例污染结论。
- 禁止 broad kill；退出旧 app 用应用级 quit 或明确 PID 级关闭。

---

## 三、强制闭环流程（Jason 新冻结）

### 3.1 默认执行顺序
任何 Mac 改动，默认按下面顺序闭环；**没走完，不要向 Jason 报“可以手测”**。

```text
改代码
  -> type-check
  -> build
  -> package（若影响 packaged 行为）
  -> 退出旧 app
  -> 启动新 app / 新包
  -> 自己完成 smoke
  -> 采集证据（命令输出 / 截图 / 资源快照）
  -> 只有证据闭环后，才能汇报 Jason
```

### 3.2 触发 packaged smoke 的场景
出现以下任一项，必须跑 packaged app smoke，而不只 dev server：
- Electron main / preload / IPC 改动
- 本地 tmux 接入改动
- 窗口恢复 / 启动 / 单实例 / app 生命周期改动
- renderer 资源占用 / 退出态 / orphan process / memory leak 排查
- 用户明确说“我要实际使用”“我要重新编译安装”

### 3.3 最低验证门槛
#### A. 静态门槛
```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

#### B. packaged 门槛（按需）
```bash
pnpm --filter @zterm/mac package
```

#### C. 运行态 smoke 门槛
至少覆盖本轮改动直接影响的主路径：
- terminal 能打开
- input / resize / scroll / split / tab 中与本轮相关的关键路径
- local tmux 或 remote bridge 至少一条真实链路
- 若改的是资源/生命周期：补 `ps/top` 资源采样 + 退出态进程检查

#### D. 证据门槛
证据至少二选二：
- 命令输出
- app 截图
- 进程 / RSS / CPU 快照
- 必要时日志 / sample

证据落点：
- `mac/evidence/<date>-<topic>/`

---

## 四、资源/泄漏专项闭环

### 4.1 资源审计最低动作
```bash
ps -axo pid,ppid,pgid,%cpu,rss,vsz,etime,comm | egrep 'PID|ZTerm|Electron Helper'
top -pid <renderer_pid> -stats pid,cpu,mem,threads,state,time -l 2
```

### 4.2 退出态检查
- 先退出旧实例
- 确认旧 PID 消失
- 再启动新实例
- 不允许跳过这一步就汇报“没有孤儿进程”

### 4.3 报告规则
- 先给证据，再给结论
- 若只完成编译、未完成运行态 smoke，只能报告“代码已编译，通过静态验证，未完成运行态闭环”
- 若只完成 dev server、未完成 packaged smoke，不能向 Jason 说“可安装使用”

---

## 五、反模式
- 编译过了就让 Jason 手测
- 只在浏览器里验证，却汇报 packaged app 可用
- 没退出旧 app 就直接打开新 app
- 没有运行态证据就下“无泄漏 / 无 orphan / 性能已优化”结论
- 让 Jason 帮忙补你本该先完成的基础 smoke

---

## 六、完成态汇报模板
只在闭环完成后使用：

```text
Jason，已完成本轮自闭环：
1. 改动：
2. 静态验证：type-check/build/package 结果
3. 运行态 smoke：做了哪些真实操作
4. 证据：截图/命令输出/资源采样位置
5. 结论：哪些已验证通过，哪些仍未覆盖
6. 现在才轮到你手测的部分：
```
