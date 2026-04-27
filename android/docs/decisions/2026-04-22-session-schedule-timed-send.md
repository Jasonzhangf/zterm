# Decision: per-session 定时发送 / heartbeat 调度真源

## 索引概要
- L1-L8 `goal`：冻结定时发送能力的唯一真源与目标。
- L10-L29 `decision`：daemon 调度、per-session 绑定、跨端 UI 复用的核心决策。
- L31-L52 `scope`：MVP 范围与明确不在范围。
- L54-L97 `model`：job 数据模型、规则类型与 target 真源。
- L99-L132 `daemon-engine`：daemon 调度器、执行路径、持久化与重启策略。
- L134-L169 `protocol`：client/daemon 协议扩展与同步方式。
- L171-L201 `ui`：Android / Mac 的日历 + 闹钟 UI 约束。
- L203-L222 `edge-cases`：rename / kill / offline / missed run 边界。
- L224-L241 `anti-patterns`：禁止形成第二真源的方案。
- L243-L257 `verification`：实现后必须覆盖的验收口径。

## 目标

为每个 tmux session 增加“定时发送文本到当前会话”的能力，覆盖：

- 周期性发送（heartbeat 风格）
- 指定时间发送
- 每日 / 每周 / 工作日 / 自定义周几重复发送

同时保持：

- **daemon 是唯一调度真源**
- Android / Mac 只做编辑、展示、启停，不做第二套本地调度
- 定时能力绑定 tmux session 真源，而不是绑定客户端临时 sessionId

## 核心决策

1. **调度真源在 daemon，不在 Android / Mac**
   - daemon 负责 job 持久化、下次触发时间计算、实际触发与结果记录。
   - Android / Mac 只负责：
     - 创建 / 编辑 / 删除 / 启停 job
     - 展示 `nextFireAt / lastFiredAt / lastResult`
     - 对当前 tmux session 发起 `run now`

2. **target 绑定 tmux session 真源**
   - job 的目标真源是 `sessionName`。
   - client 侧可以同时展示 `bridgeHost + bridgePort + sessionName`，但 daemon 内部执行目标先以 tmux session 为准。
   - 禁止把 job 绑定到 Android `SessionContext` 或 Mac runtime 的临时 `sessionId`。

3. **daemon 只维护一个 master scheduler**
   - 不采用“每个 job 一个永久 setInterval”的分散实现。
   - daemon 只维护一个调度引擎：
     - 内存中保存全部 enabled jobs
     - 唤醒时检查到期 job
     - 执行后统一计算下一个 `nextFireAt`

4. **跨端 UI 采用同一套 calendar + alarm 语义**
   - Android / Mac 都采用“日期 + 时间 + 重复规则”的统一编辑方式。
   - UI 是编辑器，不是系统级调度真源。
   - 不让 Android AlarmManager / macOS Calendar / 本地通知成为第二真源。

5. **MVP 先只支持文本发送**
   - payload 先冻结为：
     - `text`
     - `appendEnter`
   - 图片、复杂按键宏、变量模板、脚本编排不进入第一阶段。

## MVP 范围

### 包含

- per-session 定时文本发送
- interval 周期发送
- once / daily / weekdays / weekly / custom weekdays
- daemon 持久化
- `nextFireAt / lastFiredAt / lastResult / lastError`
- `run now`
- Android / Mac 同步显示同一份 daemon job 状态

### 不在范围

- cron 表达式
- 系统日历同步
- Android 本地闹钟 / iOS 本地提醒类系统调度
- 图片定时发送
- Ctrl/Alt/组合键宏
- 变量模板（如当前时间、环境变量、剪贴板）
- daemon 重启后的 backlog 补发

## Job 数据模型

shared 真源建议下沉到 `packages/shared/src/schedule/*`，避免 Android / Mac 各维护一份。

```ts
type ScheduleJob = {
  id: string;
  targetSessionName: string;
  label: string;
  enabled: boolean;

  payload: {
    text: string;
    appendEnter: boolean;
  };

  rule:
    | {
        kind: 'interval';
        intervalMs: number;
        startAt: string; // ISO
        fireImmediately?: boolean;
      }
    | {
        kind: 'alarm';
        timezone: string; // IANA
        date: string;     // YYYY-MM-DD
        time: string;     // HH:mm
        repeat: 'once' | 'daily' | 'weekdays' | 'weekly' | 'custom';
        weekdays?: number[]; // 0-6
      };

  nextFireAt?: string;
  lastFiredAt?: string;
  lastResult?: 'ok' | 'error';
  lastError?: string;

  createdAt: string;
  updatedAt: string;
};
```

### target 真源规则

- daemon 内部唯一执行 target：`targetSessionName`
- UI 展示 target 时可附带：
  - `bridgeHost`
  - `bridgePort`
  - `sessionName`
- 但只允许 `sessionName` 参与实际 tmux 发送

### payload 真源规则

- `text` 是原始语义真源，不允许为“提速/兼容”擅自裁剪文本
- `appendEnter=true` 等价于 daemon 在发送文本后再补一个 Enter
- 不允许在 daemon 侧偷偷把文本拆成多条 shell 命令做语义改写

## daemon 调度引擎

### 目录建议

- `android/src/server/schedule-store.ts`
- `android/src/server/schedule-engine.ts`
- `android/src/server/schedule-dispatch.ts`

### 持久化位置

- `~/.wterm/schedules.json`

内容建议包含：

- `schemaVersion`
- `jobs`
- `updatedAt`

### 启动流程

1. daemon 启动
2. 读取 `~/.wterm/schedules.json`
3. 为全部 enabled jobs 计算 `nextFireAt`
4. 启动单一 master timer
5. 到点后执行全部到期 job
6. 写回新的 `lastFiredAt / lastResult / nextFireAt`

### 执行策略

优先级冻结如下：

1. **mirror 在线**
   - 若当前 tmux session 已有 live mirror，优先复用现有路径：
     - `mirror.ptyProcess.write(text)`
     - 必要时补 `\\r`

2. **mirror 不在线**
   - 直接走 tmux 命令发送：
     - `tmux send-keys -t <session> -l -- <text>`
     - 若 `appendEnter=true`，再补 `Enter`

### 重启 / missed run 规则

- daemon 重启后 **不补发历史 backlog**
- 只计算下一个未来触发点
- 禁止 daemon 一重启就批量补发离线期间所有 missed jobs

## 协议扩展

shared 协议真源建议扩展：

- `packages/shared/src/connection/protocol.ts`

### client -> daemon

```ts
{ type: 'schedule-list', payload: { sessionName: string } }
{ type: 'schedule-upsert', payload: { job: ScheduleJobDraft } }
{ type: 'schedule-delete', payload: { jobId: string } }
{ type: 'schedule-toggle', payload: { jobId: string; enabled: boolean } }
{ type: 'schedule-run-now', payload: { jobId: string } }
```

### daemon -> client

```ts
{
  type: 'schedule-state',
  payload: {
    sessionName: string;
    jobs: ScheduleJob[];
  }
}

{
  type: 'schedule-event',
  payload: {
    sessionName: string;
    jobId: string;
    type: 'triggered' | 'updated' | 'deleted' | 'error';
    at: string;
    message?: string;
  }
}
```

### 同步规则

- daemon 是唯一状态真源
- 任一端修改后，daemon 负责广播新的 `schedule-state`
- Android / Mac 不得各自本地乐观生成第二份持久状态
- 只要 client 当前 attach 到某个 `sessionName`，就必须**随时**可以打开该 session 的 schedule 列表并 CRUD
- “当前是否有本地预输入草稿”只影响新建表单的 seeded text，**不影响**当前 session 任务列表的查看/编辑入口
- 任意客户端 attach 到同一个 `sessionName` 时，都必须看到 daemon 侧这一份 session 任务列表；禁止按客户端临时 `sessionId` 再切第二份 schedule 真相

## UI 结构冻结

### 入口位置

- Android：Terminal 顶部连接栏增加 alarm / clock 入口
- Mac：Terminal toolbar / meta bar 增加 alarm / clock 入口

### Session Schedule Sheet

两端统一使用同一套语义：

1. 当前 target session
2. 任务列表
3. 新建按钮
4. 编辑器表单：
   - 文本内容
   - `发送后回车`
   - 规则类型：`周期 / 闹钟`
   - 周期模式：N 秒 / 分 / 小时，是否立即执行一次
   - 闹钟模式：日期、时间、重复规则
   - 启用/停用
   - 下次触发时间
   - 上次执行结果

### 日历 + 闹钟 UI 约束

- 规则编辑语义必须统一
- Android / Mac 允许平台风格差异，但不能改变字段结构和业务含义
- 不允许一端支持 weekdays，另一端只支持 daily
- 不允许一端是 interval 真源、另一端是 wall-clock 真源

## 关键边界条件

1. **tmux rename**
   - session rename 后，daemon 必须把旧 `targetSessionName` 下的 jobs 迁移到新名字
   - 同时重算 `nextFireAt`
   - 广播新的 `schedule-state`

2. **tmux kill**
   - session 被 kill 后，job 不自动丢失
   - job 进入 disabled 或 error 状态
   - `lastError = session not found`

3. **client 全部离线**
   - 任务仍应由 daemon 继续触发
   - 禁止把执行能力绑定到“必须存在 live websocket client”

4. **run now**
   - `run now` 也走 daemon 真源执行路径
   - 不允许 client 绕过 daemon 直接本地模拟“已执行”

## 反模式

- 把 job 绑定到客户端 runtime `sessionId`
- Android 本地 `setInterval` 和 daemon 同时触发
- Mac 本地 timer 和 daemon timer 并行存在
- 用系统日历/本地闹钟做实际发送真源
- client 本地保存一份 schedule 列表，daemon 再保存一份
- 为了“更快”在 daemon 侧裁剪原始文本 payload

## 验证口径

实现后至少覆盖：

1. interval job 到点周期触发
2. alarm once job 只触发一次
3. daily / weekdays / weekly / custom weekdays 触发正确
4. daemon 重启后 job 仍存在且只计算未来触发点
5. 无 live client 时 job 仍能打到 tmux session
6. Android / Mac 同时打开时，任一端修改都能同步到另一端
7. rename session 后 job 自动迁移
8. kill session 后 job 进入可见错误态，不静默丢失
