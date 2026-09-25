# Android DAGpipe Phase 0 设计切片（中文语义版）

状态：只做静态架构切片。以下 Operator 都是计划绑定，尚未在 Rust 注册，
也尚未通过 `pipeline_runtime` 执行。

## 目标与范围

- 覆盖 Android 客户端的四组路径：
  1. Relay 账号登录与设备目录
  2. 目标连接建立、维持、恢复（单 session 与多 session）
  3. Android buffer 管理状态机（每 session 独立）
  4. buffer 到 render 的原子投影，以及输入发送链
- 本阶段只做图 JSON、CLI 校验和本设计切片。
- 不新增 `Cargo.toml`、不注册 Operator、不调用编译与运行时接口、不改
  Android runtime 代码。

## 身份与角色

执行身份：

- 项目身份：`zterm`
- 图身份：`android.connection_lifecycle`、`android.buffer_management`、
  `android.buffer_render`、`android.input_dispatch`
- 图版本：当前全部 `0.1`
- 每次执行的 `execution_id` / `attempt_id` 由调用方提供；重试必须使用新
  attempt，不允许在图里造环。

角色：

- Relay 账号角色：负责登录、刷新、token-per-login、设备 presence 与目录
  投影。它不持有终端正文、tmux、mirror 或 renderer 真相。
- 路由解析角色：把手工目标、Tailscale、UDP direct、Relay 目录候选解析成
  可解释的候选线路。它只生成线路计划，不拥有物理连接状态。
- 目标连接角色：每个稳定 daemon 目标只有一个物理 transport。它负责建立、
  mux 协商、心跳、网络变更校验、重连与退避、连接代际。它不持有 tab、
  foreground、viewport、renderer 或 session 业务真相。
- 会话通道角色：每个打开的本地 session 是一个独立逻辑通道。它负责通道
  open/close、body 订阅、按 session 的请求 lane。一个通道失败不得连坐同一
  目标上的其他通道。
- 会话调度角色：负责 active / inactive 取数频率与多 session 轮转。它只
  调度刷新，不拥有 sparse buffer 或 renderer 可见窗口。
- Buffer 管理角色：每个 session 独立维护 absolute-row sparse truth、
  revision epoch、缺口 repair 与 repair ledger。它不持有 renderer
  follow/reading/renderBottomIndex。
- Renderer 窗口角色：唯一持有可见范围、follow/reading、renderBottomIndex。
  它不请求 transport，不决定 buffer 拉取。
- 输入角色：只做纯文本归一和有序可靠发送队列，不做 transport、session
  生命周期或终端内容真相。

禁止：

- Operator 不接收 graph、scheduler、Runtime 或 ARC store。
- 任何 Operator/hook 不得修改图结构，不得用循环代替重试。
- 客户端角色不得改写 daemon mirror/transport 真相。
- Renderer 和 DOM 投影不得直接发起 buffer/transport 请求。

## 事件

Relay / 连接事件：

- 登录成功：账号会话建立，token 只属于本次登录设备。
- 登录失败 / 鉴权拒绝：显式进入错误态，不清除已保存的直连目标。
- 目录快照更新：同 `hostId` 最新快照原子替换旧 endpoints/sessions。
- 心跳超时：物理 transport 或 Relay 设备控制流按各自阈值关闭；终端通道
  不作为心跳证明。
- 通道打开成功 / 失败：按 session 独立结算。
- 物理连接失效：目标连接角色计划一次新的连接代际；已有健康通道不得被
  Relay 目录更新或 foreground/background 切换重建。

Buffer / render 事件：

- head 到达：只更新本地 head/cursor metadata，不触发正文 repaint。
- 完整 frame 到达：只在 frame 无洞连续后进入 sparse apply。
- frame 拒绝：保留 exact repair range，不提升本地 revision，不发布 render。
- 可见缺口：buffer 管理角色发出 exact-range 请求；未实际写入 wire 前保持
  pending。
- sparse apply：唯一可触发正文 render commit 的 body truth 事件。
- render snapshot：只允许 immutable 投影进入 DOM。

输入事件：

- 提交文本到达：进入纯文本归一。
- 归一完成：进入可靠输入队列计划。
- 队列发送：只通过当前 mux channel 输出，不替换物理 transport。

## 状态机

### Relay 账号状态

- 未登录：可展示直连目标，不依赖 Relay。
- 鉴权中：等待登录/刷新结果。
- 已登录：拥有本次登录 token、设备 presence 与目录投影。
- token 失效：显式清除本地账号投影，不再用旧 token 重连。

转换：

- `(未登录, 用户提交账号) -> 鉴权中`
- `(鉴权中, 登录成功) -> 已登录`
- `(已登录, 鉴权拒绝) -> 未登录（保留直连目标）`
- `(已登录, 退出) -> 未登录`

### 目标物理连接状态

- 空闲：没有需要维持的目标连接。
- 解析线路：按 Auto 顺序或手工策略生成候选。
- 建立连接：物理 transport 正在打开。
- mux 协商：等待 hello/ready。
- 就绪：一个目标一个物理 transport，心跳正常。
- 恢复：物理失效后进入新连接代际，使用新 attempt。
- 鉴权失败 / 终态：停止自动重连，显式投影错误。

转换：

- `(空闲, 目标/策略) -> 解析线路`
- `(解析线路, 选定线路) -> 建立连接`
- `(建立连接, transport open) -> mux 协商`
- `(mux 协商, ready) -> 就绪`
- `(就绪, 心跳超时/物理失败) -> 恢复`
- `(恢复, 新代际成功) -> 就绪`
- `(鉴权失败, 终态) -> 空闲/错误`

单 session：一条通道完成即可进入可用。多 session：同一物理 transport 上
按需求集合打开多条通道；每条通道有独立 open/close/body 订阅状态。

### 会话通道状态

- 无需求：没有对应 open tab 或用户没有进入该 session。
- 打开中：通道 open 请求已发出。
- 已打开：通道 ready，可读可写。
- 已订阅：接收 body 数据。
- 关闭中 / 已关闭：只影响本通道。

转换：

- `(无需求, 显式进入/open intent) -> 打开中`
- `(打开中, channel opened) -> 已打开`
- `(已打开, body demand) -> 已订阅`
- `(已订阅, 暂停/inactive) -> 已打开（停止 body 取数，不关通道）`
- `(已打开/已订阅, 用户关闭或物理通道失效) -> 已关闭`

### Android buffer 管理状态

每个 session 独立运行：

- 未初始化：尚无本地 buffer truth。
- head 已观察：拿到 daemon head/cursor metadata。
- 尾部追赶：按当前 tail 拉连续无洞窗口。
- 在线：本地窗口贴住 tail，按 active/inactive 调节取数。
- 缺口修复：可见范围有 gap，进入 exact-range repair。
- revision 重置：daemon 重连或显式新 epoch 后重建本地窗口，但保留已有
  absolute-row 内容直到权威数据覆盖。

转换：

- `(未初始化, head 到达) -> head 已观察`
- `(head 已观察, tail 拉取成功) -> 在线`
- `(在线, 可见 gap / frame 拒绝) -> 缺口修复`
- `(缺口修复, 权威覆盖) -> 在线`
- `(在线/缺口修复, daemon revision 重置) -> head 已观察`
- `(任意, 用户关闭 session) -> 已销毁`

active session：高频 head-first；visible passive session：有界轮转；
inactive session：停止主动拉取但保留 buffer truth，不关闭 transport。

### Frame assembly / repair ledger

- 无 pending frame
- 组装中
- frame 就绪
- repair pending
- repair dispatched

转换：

- `(无 pending frame, chunk 到达) -> 组装中`
- `(组装中, 完整无洞) -> frame 就绪`
- `(frame 就绪, sparse apply) -> 无 pending frame`
- `(组装中, 拒绝) -> repair pending`
- `(repair pending, 实际写 wire) -> repair dispatched`
- `(repair dispatched, 权威 apply 覆盖) -> 无 pending frame`
- `(任何, revision epoch 重置) -> 无 pending frame`

禁止逐 chunk 发布、禁止跨 frame 混入、禁止未实际写 wire 就提前记为
dispatched。

### Renderer window

- follow：贴住最新尾部。
- reading：用户上滚后保持滚动位置。

转换：

- `(follow, 用户上滚) -> reading`
- `(reading, 到底/重新进入/用户输入) -> follow`

IME 弹起、容器 relayout 不进入 reading。

### 可靠输入队列

- 空闲
- 排队
- 在途
- 背压

转换：

- `(空闲, 归一完成) -> 排队`
- `(排队, 有发送槽) -> 在途`
- `(在途, ACK) -> 空闲`
- `(在途/排队, 窗口满或高水位) -> 背压`
- `(背压, 排空/低水位) -> 在途`

## DAG 与数据契约

### android.connection_lifecycle@0.1

输入：

- 账号凭据
- Relay 配置
- 目标候选
- session 需求集合（支持 1..N）
- 连接策略

节点语义：

1. 登录 Relay 账号
2. 发布本机设备 presence
3. 解析目标线路
4. 建立目标物理 transport
5. 协商 mux
6. 按需求集合打开 session 通道
7. 订阅各通道 body
8. 维持连接健康
9. 规划恢复

输出：

- 连接健康
- 恢复计划
- 各通道 body 订阅事实

### android.buffer_management@0.1

输入：

- session buffer 需求（active / visible passive / inactive）
- daemon head 事实
- 本地 sparse buffer 状态
- buffer 策略

节点语义：

1. 观察各 session 的 daemon head
2. 计划各 session 的拉取窗口
3. 发送 range 请求
4. 接收 range 响应
5. 合并 sparse truth
6. 更新 repair ledger
7. 发布 render scope

输出：

- range 请求
- repair ledger
- render scope

### android.buffer_render@0.1

输入：

- daemon wire frame
- renderer 声明的可见范围
- 本地 sparse 状态
- buffer 策略

节点语义：

1. 归一 wire frame
2. 组装完整 frame
3. 规划 sparse apply / repair
4. 应用 sparse truth
5. 发出 exact repair 请求
6. 提交 render snapshot
7. 投影 DOM

输出：

- exact repair 请求
- DOM 投影

### android.input_dispatch@0.1

输入：

- 已提交文本
- 输入策略
- transport 观察事实

节点语义：

1. 归一提交文本
2. 计划可靠输入批次
3. 发送到当前 mux channel

输出：

- mux channel 发送

## 触发条件

- Relay 登录只在用户显式账号动作或已验证刷新需要时触发。
- 物理连接只在目标已解析、存在需要维持的 session 需求时建立。
- 已健康的目标 transport 不因 Relay 目录更新、foreground/background 或
  tab 切换而重建。
- Buffer 拉取只在 head 到达且该 session 有对应 demand 时计划；inactive
  不主动拉取。
- 正文 repaint 只允许在完整无洞 frame sparse apply 后发生。
- 输入发送只在归一和队列计划完成后发生，且必须走当前 mux channel。

## 状态闭合与资源释放

每个状态机都必须有终态和释放终点，不允许只停在“工作态”。终态是否可恢复必须
显式声明；可恢复用新 attempt/新执行身份，不可恢复通过显式重建入口才允许再次
进入。

### Relay 账号

终态：

- 登录成功：不是终态，可继续维持心跳与目录更新。
- 未登录：账号级终态，来自退出、鉴权拒绝或显式清理。
- 鉴权拒绝：本地 Relay 账号、Relay 配置和目录投影显式清除；不清除已保存的
  direct / Tailscale 目标，也不关闭仍健康的 terminal 物理 transport。

非法转移：

- 鉴权拒绝后不得用旧 token 自动重连。
- token 失效不得被目录快照或控制流心跳掩盖。

### 目标物理连接

终态：

- 释放 / 销毁：用户显式断开，或最后一个需要保留的目标 session 关闭后，由连接
  角色取消心跳 timer、关闭物理 transport、释放连接代际和 channel registry。
- 鉴权失败：停止自动重连并投影错误；用户可显式重新登录或切换目标后再建立。

恢复：

- 物理失败进入恢复态，恢复是新连接代际，使用新 attempt；旧代际事件必须被拒绝。
- 物理 transport 销毁只影响该 target 下所有逻辑 channel 的物理承载，不 kill
  tmux，不伪造客户端 session 已关闭。

### 会话通道

终态：

- 已关闭：只释放该通道的 body 订阅、pending 请求、input lane 与 buffer 资源。
- 已销毁：用户显式关闭或目标物理连接销毁导致通道确认关闭；其他 sibling
  通道不受影响，除非物理 transport 本身销毁。

资源释放：

- body 订阅关闭只停 unsolicited body，不关物理 transport。
- 最后一个 session 关闭后，目标连接角色按需求决定是否释放物理 transport 与
  服务生命周期；前后台切换不触发释放。

非法转移：

- inactive 不得把已打开通道转成销毁。
- 一个通道错误不得通过把其他通道重连来掩盖。

### Buffer 管理

终态：

- 已销毁：用户显式关闭 session 时删除该 session 的 sparse truth、revision
  epoch、frame assembly、repair ledger 和 render scope。
- revision 重置：authoritative lower head 是一次新 epoch；只清理旧 epoch 的
  pending frame / repair ledger 一次，重复 lower head 不得重复清除。

资源释放：

- inactive / tab switch 不销毁 buffer truth，不关闭 transport。
- hidden pane 不保留 renderer 实例；renderer scope 只覆盖当前可见 pane。
- frame assembly 超时或资源上限必须显式释放 incomplete chunks，并按精确范围
  repair；不能等 session close 作为释放借口。

非法转移：

- 没有完整无洞 frame 不得从“组装中”到“已应用”。
- repair 未实际写 wire 不得从 pending 到 dispatched。
- 窗口规划错误不得清空已有 absolute-row truth。

### Renderer window

终态：

- 无独立终态；session 销毁或 pane hidden 时 renderer 实例移除。

非法转移：

- IME / relayout / 隐藏 pane 不得把 follow 误判成 reading。
- renderer 不持有 buffer 或 transport 生命周期，不能因 renderer 消失关闭
  transport。

### 可靠输入队列

终态：

- 队列随 session 销毁；用户显式关闭前不清空未确认输入。
- transport 代际变化只重置 sent 状态，不丢未确认数据；stale / session-required
  nack 保持 retryable，invalid / oversize 非 retryable。

非法转移：

- 输入 owner 不得直接替换物理 transport。
- queue 不得因背压把失败静默投影成成功发送。

## 单 / 多 session 收口

单一 session：

- 一条目标连接上一条通道；连接健康只关联该通道需求。
- 最后一条通道关闭即触发目标连接释放判定。

多 session：

- 多条通道共享一条目标连接；关闭其中一条只释放该通道资源。
- 多条通道的 buffer / repair / revision 互不共享；一个通道的 repair 高峰不得
  永久占住物理发送预算。
- 如多通道目标连接释放发生在所有通道都关闭之后；只要还有存活通道，物理
  连接就保留。

## 单 session 与多 session

单 session：

- 一个目标物理 transport 上只有一条通道。
- buffer 管理只调度该 session；repair、revision、renderer scope 都只关联
  该 session。

多 session：

- 同一 daemon 目标只建立一个物理 transport，多个 session 是逻辑通道。
- 每个 session 通道独立 open/close、body 订阅、head/range lane。
- 每个 session 的 buffer 状态机、repair ledger、revision epoch 互不共享。
- 一个 session 通道失败或缓冲错误不得阻塞其他 session。
- active 通道高频刷新；visible passive 通道有界轮转；inactive 通道只停
  取数，不关 transport。
- Renderer scope 只覆盖当前可见 pane；hidden pane 不保留 renderer 实例。

## 变更边界

本阶段范围内：

- `android/docs/dagpipe/*`
- `android/scripts/validate-dagpipe-graphs.mjs`
- `android/package.json` 的 `test:dagpipe-phase0`

审批前不进入：

- `Cargo.toml` / Rust crate / `pipeline_runtime` 依赖
- daemon runtime、Android runtime、wire protocol
- prebuild/CI 对 `dagpipe` 全局 CLI 的接入
- APK / OTA / 发布

必须证据：

- `dagpipe graph validate` 通过全部六张图。
- `dagpipe graph inspect` 输出确定性 waves 与 operator 绑定。
- `pnpm --dir android test:dagpipe-phase0` 通过。
- Phase 1 必须再补 SDK `compile()` 合同/effect 检查、Rust 测试、与当前 TS
  行为的黑盒 parity，只有全部通过才允许接线。

## 不是运行时结论

这些图是 Phase 0 静态契约，不执行。图通过只代表拓扑与绑定语法有效，
不代表 Android 连接、buffer 或渲染已经接入 DAGpipe runtime。
