# 2026-04-23 Terminal head / sparse buffer / render container truth

> Supersedes older terminal buffer/render directions whenever they conflict.

## 决策

terminal 链路收敛为四层单向模型：

```text
Server(session truth)
  -> head broadcast
  -> Client Buffer Worker
  -> Renderer Container
  -> UI Shell
```

核心铁律：

1. **消费者只消费，不生产，不改源**
2. **Server 不主动推 buffer 内容，只广播 head，并按 range 响应**
3. **Client buffer 是 sparse buffer，可不连续，不为“完整性”主动补洞**
4. **Renderer 只按 index window 渲染，不关心 buffer 是否完整**
5. **UI 只移动/裁切容器；IME/键盘不影响内容真相**

---

## 1. Server 真源职责

### 1.1 session 是唯一单位

- client 与 server 按 `session` 握手和建立联系
- 每个 session 的 head / range / input 全部独立
- 不允许多个 session 共用一份 buffer 真相

### 1.2 server 只做两件事

#### A. 周期性广播 head

- 每个 session 固定 **30 次/秒** 广播 head
- head 只描述最新尾部事实，不携带行内容

最小 head 结构冻结为：

```ts
type BufferHead = {
  sessionId: string
  revision: number
  latestEndIndex: number
}
```

说明：

- `latestEndIndex` 是 exclusive tail index
- server **不关心显示**，因此 head **不带 `viewportEndIndex`**

#### B. 按 range 响应 lines

- client 请求 `[startIndex, endIndex)` 哪个绝对范围
- server 就返回该绝对范围内已有的 lines
- server 不替 client 猜窗口，不主动补 client 缺口

建议最小协议：

```ts
type BufferRangeRequest = {
  sessionId: string
  startIndex: number
  endIndex: number
  knownRevision: number
}

type BufferRangeResponse = {
  sessionId: string
  revision: number
  startIndex: number
  endIndex: number
  lines: Array<{ index: number; cells: TerminalCell[] }>
}
```

### 1.3 server 明确不做的事情

- 不主动 push 大块 buffer payload
- 不保存 client 的 reading/follow 作为 server 长期状态
- 不根据 renderer 当前窗口改自己的生产逻辑
- 不参与渲染
- 不感知 keyboard / IME / UI 裁切

---

## 2. Client Buffer Worker 真源职责

Client buffer worker 是客户端唯一的 buffer 维护者。

### 2.1 sparse buffer 冻结

client buffer 的真相是：

- **按绝对行号缓存的 sparse rows**
- 可以缓存例如 3000 行
- 这 3000 行**允许不连续**
- buffer 不要求内部总是拼成连续数组

### 2.2 worker 只关心 head + 本地已有 ranges

worker 只处理：

1. server 最新 `head`
2. 本地当前已拥有的绝对 ranges
3. 当前工作集缺哪些 range

它不关心：

- UI 长什么样
- keyboard 有没有弹出
- 容器被裁掉多少
- renderer 的 DOM / scroll / 动画

### 2.3 不为完整性主动补洞

worker **不因为发现历史有洞就主动补**

它只在“当前工作集需要”时补：

- follow 态：自动维护尾部工作集
- reading 态：只补当前 renderer 要看的窗口

### 2.4 follow / reading 的工作集

#### follow（不滚动）

- follow 就是不滚动、贴近最新输出的状态
- 这个状态下 buffer **自动获取最新 diff 并拼接**
- 不要求整体连续；局部连续即可

follow 态默认工作集冻结为：

```text
[latestEndIndex - viewportRows * 3, latestEndIndex)
```

也就是**尾部 3 屏热区**

规则：

- worker 收到新 head 后，自动围绕这个热区做 diff 决策
- 已有行不重复拉
- 缺失行按缺口拉
- 不为了热区外的完整性主动补历史

#### reading（用户回滚）

- reading 时不去拉全部历史
- 只在滚到某个窗口、renderer 真正需要该窗口时，才补该窗口缺失部分
- “滚到那里再补”是唯一规则

### 2.5 响应处理原则

buffer 只关心**当前这次行为**：

- 请求了哪个范围，就 merge 这个范围
- merge 完以后，如果它已经落后于最新 head，再下一轮继续决策
- 不需要一次请求同时解决“当前需求 + 全局最新”

换句话说：

> 请求什么得什么；是否还要再请求，由下一轮独立决策。

### 2.6 hidden tab 策略

hidden tab 冻结为：

- 只收 head
- 不拉 range
- 不补缺口
- 不渲染
- 切回 active 后，再按当前窗口补

### 2.7 尾部热区 patch 规则

- 尾部热区（默认 3 屏）允许 patch / rewrite
- 热区外默认视为历史事实，不主动重拉

这样可以兼容：

- prompt 改写
- 当前输入行变化
- curses/tui 尾部刷新

同时避免全历史反复重拉。

---

## 3. Renderer Container 真源职责

renderer 是纯消费者。

### 3.1 renderer 不关心 buffer 是否完整

renderer 只管理：

- 当前渲染相对于底部的位置
- 当前需要的绝对 index window
- 当前窗口相对于 buffer 的命中情况

它不管理：

- 网络
- 补洞策略
- head 广播频率
- server 状态

### 3.2 bottom-relative window

renderer 只从“当前底部”开始算窗口：

```text
latestEndIndex
+ relative offset from bottom
= render window
```

也就是：

- latest：渲染最新窗口
- reading：渲染“相对最新往前多少”的窗口

renderer 不需要知道 buffer 全局是否完整。

### 3.3 renderer 与 worker 的关系

renderer 只声明：

> “我现在要渲染 `[startIndex, endIndex)` 这个窗口。”

然后：

- 如果 buffer 已命中且连续：直接画
- 如果当前窗口缺失：通知 worker 补缺

renderer **不能直接发 transport request**

### 3.4 缺失窗口的呈现

renderer 不冻结上一帧，不造假。

当前窗口缺失时：

- 已有的行先画
- 缺失行显示 gap / loading 占位
- 等 worker 补齐后再自然更新

---

## 4. UI Shell 真源职责

UI 只负责容器的**呈现位置与裁切**。

### 4.1 UI 负责

- 容器在屏幕上的位置
- 容器往上移/往下移多少
- 当前可见高度
- 哪些区域被遮挡/切掉

### 4.2 IME / keyboard 规则

输入法弹出 / 收起：

- **只影响 UI shell 的位置与裁切**
- 不影响 buffer 内容
- 不影响 worker 决策
- 不影响 renderer 的内容真相
- 不影响 session 的最新尾部

也就是：

> 内容还是那些内容，只是“看得见多少、显示在什么位置”变了。

### 4.3 actual resize 与 keyboard 区分

只有真实 geometry resize 才影响 renderer 的逻辑 viewport：

- 窗口尺寸变化
- 分屏比例变化
- 字体/行高真实变化

keyboard / IME 不属于 geometry resize。

---

## 5. 请求/响应闭环

### 5.1 follow 主循环

```text
server 广播 head
-> worker 比较尾部 3 屏工作集
-> 发现缺口
-> 请求缺失 range
-> merge sparse buffer
-> renderer 继续消费当前窗口
```

### 5.2 reading 主循环

```text
renderer 请求某个 reading window
-> worker 检查该 window 是否缺失
-> 只请求该 window 内缺失 range
-> merge sparse buffer
-> renderer 补齐显示
```

### 5.3 旧响应处理

旧响应不因为“不是最新 revision”就直接丢弃。

冻结规则：

- 这次请求什么范围，就 merge 这个范围
- merge 完以后，如果仍然不是最新，再下一轮继续请求
- worker 每次只独立处理当前行为

也就是说：

> response 的价值取决于它补没补上当前需要的 range，不取决于它是不是全局最新。

---

## 6. 明确废止的旧方向

以下设计以后都视为错误方向：

1. server 主动推大块 buffer payload
2. renderer 直接参与 request / prefetch / transport
3. keyboard / IME 进入 buffer truth 链
4. 消费者把自己的消费状态回灌给生产者，变成生产者长期行为依据
5. 为了“完整性”主动补齐全部历史
6. hidden tab 在后台继续拉 range / 补洞 / 渲染

---

## 7. 实现切分建议

后续重做按四层拆：

1. **server/session-head**
   - session 握手
   - 30Hz head 广播
   - range request -> range response
2. **client/buffer-worker**
   - sparse buffer
   - working-set diff planner
   - active session 固定 `33ms` head freshness cadence
   - tail / reading range frequency 按网络状况与配置分级
   - follow / reading range pulling
3. **renderer/container**
   - bottom-relative render window
   - gap / loading consume only
4. **ui/shell**
   - keyboard / inset / crop / presentation

---

## 8. 成功标准

必须同时满足：

1. daemon 只广播 head，不主动推 buffer 内容
2. client buffer 可不连续，且不会因历史缺口主动补全
3. follow 态自动维护尾部热区；reading 态只补当前窗口缺口
4. hidden tab 只收 head，不拉 range
5. `sendInput()` 不做本地回显，但 active session 会挂 `input-tail-refresh` demand，并由本地 cadence 主动拉 follow canonical buffer
6. renderer 只按 index window 渲染，不直接请求 transport
7. IME 弹出/收起只改 UI 呈现位置，不改内容真相
