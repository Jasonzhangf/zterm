# zterm Mac Architecture

## 真源层级

1. `mac/docs/spec.md`：Mac 重写目标与阶段验收
2. `mac/docs/architecture.md`：Mac 模块边界与 ownership
3. `mac/docs/dev-workflow.md`：Mac 验证门禁
4. `android/docs/architecture.md`：跨端共享 terminal ownership 真源
5. `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`：terminal head / sparse buffer / render container 真源
6. `.agents/skills/terminal-buffer-truth/SKILL.md`：buffer/render/scroll 硬门禁
7. `mac/task.md`：Mac rewrite 任务板
8. `mac/CACHE.md`：当前切片短期上下文
9. `mac/MEMORY.md`：长期经验
10. `mac/evidence/`：验证证据

## 核心模型

Mac 与 Android 共享同一套四层模型：

```text
Server(session truth)
  -> Client Buffer Worker
  -> Renderer Container
  -> UI Shell
```

### 1. Server(session truth)

- tmux / daemon 是唯一 session truth
- server 只负责 head broadcast + range response
- server 不维护 Mac 专属 viewport / reading / shell state

### 2. Client Buffer Worker

- Mac 侧 buffer 只能是 sparse absolute-index mirror
- hidden / inactive 只收 head，不后台偷偷补整段历史
- buffer worker 不关心桌面 window chrome / launcher / modal

### 3. Renderer Container

- renderer 只消费当前 render window
- renderer 只对接 projection，不直接碰 transport
- renderer 不生产第二份 cursor / viewport 真相

### 4. UI Shell

- 只负责 header / tabs / launcher / editor / terminal surface 布局
- 不负责 buffer 合并
- 不负责 transport request 决策
- 不把桌面 split/tab 行为回灌成 terminal 内容真相

## Phase 1 当前模块边界

### Electron Platform Shell

- `mac/electron/*`
- 负责窗口创建、preload、生命周期
- 不承载 terminal truth

### Mac App Shell

- `mac/src/app/*`
- 负责：
  - terminal-first header
  - minimal tab strip
  - launcher / editor overlay
  - active tab 选择
- 不负责：
  - buffer merge
  - viewport sync 策略
  - websocket 协议细节

### Runtime Adapter（临时过渡层）

- 当前仍复用 `mac/src/lib/terminal-runtime.ts`
- 只作为 Phase 1 过渡，给新 app shell 提供一个真实 live runtime
- 下一阶段要继续切成与 Android 一致的 session head / sparse buffer worker contract

### Shared Truth

- `packages/shared/src/connection/*`
- `packages/shared/src/react/use-host-storage.ts`
- `packages/shared/src/react/use-bridge-settings-storage.ts`
- `packages/shared/src/react/terminal-view.tsx`

shared 继续承载：

- host / bridge settings
- terminal theme
- shared terminal renderer

## 当前明确废止的旧方向

1. 旧 `ShellWorkspace` 继续作为 Mac 主入口
2. 用 workspace/profile/pane 编排组件顺手维护 terminal runtime 真相
3. 在桌面壳层里混入第二套 terminal session ownership
4. 先做大 split / profiles / local tmux，再回头补 contract

## 当前切分顺序

1. **切入口**：App -> 新 Mac App Shell
2. **切 ownership**：tabs / launcher / active target 改由新 shell 持有
3. **保 runtime**：先接旧 runtime adapter 保住真实 live terminal
4. **再继续切**：buffer worker / split / local tmux
