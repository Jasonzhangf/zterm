# 2026-04-23 Terminal head / buffer manager / renderer truth

> 本文档是 terminal 链路唯一真源。若旧文档、旧实现、旧测试与本文冲突，以本文为准。

## 决策

terminal 链路固定为四层独立模型：

```text
tmux truth
  -> daemon server
  -> client buffer manager
  -> renderer
  -> UI shell
```

### 冻结原则

1. **server 独立**：只 mirror tmux truth，只回答 head 和 range
2. **buffer manager 独立**：只管和 daemon 同步，不管渲染
3. **renderer 独立**：只管 render window，不管 buffer 拉取
4. **UI shell 独立**：只管容器位置与裁切，不管内容真相
5. **不允许 fallback / snapshot / planner / 第二语义**

---

## 1. daemon server

server 只做四件事：

1. mirror tmux buffer truth
2. 处理 `buffer-head-request`
3. 处理 `buffer-sync-request`
4. 处理 `connect / input / resize`

### 1.1 server 响应规则

- `buffer-head-request`：返回当前 head
- `buffer-sync-request`：返回请求区间 buffer
- **任何回复都带当前 head**

最小响应语义：

```ts
type BufferHead = {
  sessionId: string
  revision: number
  latestEndIndex: number
}

type BufferSyncResponse = {
  sessionId: string
  revision: number
  latestEndIndex: number
  startIndex: number
  endIndex: number
  lines: Array<{ index: number; cells: TerminalCell[] }>
}
```

### 1.2 server 明确不做

- 不做 follow / reading 判断
- 不做 request planner
- 不做 snapshot / fallback
- 不做 gap 判断
- 不做 renderer 决策
- 不做“客户端应该拉哪段”的策略
- 不因 client 断开 / 切 tab / subscriber 归零就销毁 mirror truth；mirror 的 `revision / latestEndIndex / absolute line window` 不能随着 client 生命周期重置

server 不关心客户端行为；它只是 tmux mirror。

---

## 2. client buffer manager

buffer manager 是客户端唯一 buffer worker。

### 2.1 唯一职责

- 自己起 timer
- 定时先问 head
- 比较本地 local buffer 与 daemon head
- 决定这次该请求哪段 buffer
- merge 到本地 sliding buffer
- 在 head 变化或 gap repair 完成后通知 renderer

### 2.2 本地 buffer 结构

- 客户端默认/最大维护 **1000 行** sliding buffer
- 绝对行号存储
- 允许 sparse
- 历史超出窗口后再滑走
- 单次 payload 不是“重建本地 buffer”的命令

### 2.3 follow 主路径

每轮都先问 head，然后比较本地尾窗和 daemon head：

#### 情况 A：本地为空 / 失真 / 距离 head 超过 3 屏

直接：
- 请求 `head` 最新三屏
- 把本地 sliding window 移到最新尾部
- **中间缺口不补**

#### 情况 B：本地仍在 head 附近

只补 diff。

### 2.4 reading 主路径

reading 不改变 head-first 主循环。

它只是给 buffer manager 额外一个渲染需求：
- 当前 reading window 是多少
- 当前 reading window 内是否有 gap

只有 reading window 不连续时，buffer manager 才请求 gap。

### 2.5 buffer manager 明确不做

- 不关心 renderer 的 DOM / scroll / IME
- 不关心容器位置
- 不直接修改 renderer 的 mode
- 不在 follow 下因为历史 gap 去回补整段旧历史
- 不允许 snapshot / patch-middle / fallback

---

## 3. renderer

renderer 只消费本地内容池，不驱动 transport。

### 3.1 renderer 真相

renderer 只维护：
- `mode`: `follow | reading`
- `renderBottomIndex`

派生：

```text
renderTopIndex = renderBottomIndex - viewportRows
renderWindow = [renderTopIndex, renderBottomIndex)
```

### 3.2 follow

- follow 时，收到 head / buffer 更新后
- 将 `renderBottomIndex` 对齐到最新底部
- 重新从本地 buffer 取当前窗口渲染

### 3.3 reading

- 用户上滚进入 reading
- reading 时只改自己的 `renderBottomIndex`
- 取的是 reading head 往回 3 屏的渲染窗口
- buffer 更新不会自动改变滚动语义

### 3.4 reading 退出条件

只允许：
1. 重新进入
2. 下滚到底
3. 用户输入

### 3.5 renderer 明确不做

- 不直接 request daemon
- 不决定 buffer pull
- 不修改 buffer 内容
- 不因为 buffer 变化自动滚动

---

## 4. UI shell

UI shell 只负责：
- terminal 容器位置
- 可见区域裁切
- keyboard / IME 抬升

### 4.1 IME 规则

- IME 只移动容器，不改变内容
- IME 不影响 buffer manager 决策
- IME 不影响 renderer 内容真相

---

## 5. 明确废止的旧实现

以下全部废止：

1. server 侧 planner / follow / reading 策略
2. stream-mode
3. snapshot / bootstrap 快照语义
4. renderer 直接触发 buffer request
5. buffer manager 直接改 renderer 状态
6. follow 下修本地历史 gap
7. 靠 fallback / 第二语义兜底

---

## 6. 真回环验收

必须同时看：

```text
tmux truth
-> daemon response
-> client buffer manager merge
-> renderer commit
-> Android APK 真实画面
```

最小场景：
1. 初次连接
2. 后台恢复
3. 输入英文 / 数字 / 空格 / 回车
4. reading 连续上滚
5. 输入退出 reading
6. daemon 重启恢复
