# Vikunja ticket adapter 目标版本独立验证报告

## 结论

选定目标版本为 `Vikunja v2.7.1`，API 前缀为 `/api/v2`。隔离实例验证表明，任务
CRUD、评论、项目访问隔离、token 撤销/过期、分页排序和 bot 成员映射均可作为
adapter 的真实接入基础。

唯一明确 FAIL 是“原生 `Idempotency-Key` 不受支持”：相同 payload 带相同
`Idempotency-Key` 连续创建两次，返回两个不同 task id。Vikunja v2.7.1 不能提供
该 header 的原生幂等保障。

“真实请求超时后的对账/恢复”仍是 UNVERIFIED。两次成功 POST 只证明原生 header
幂等缺失，不构成真实超时测试。adapter 尚未实现，本任务也不把本地重试当作成功。

成员映射不要求伪造人类账号。bot 是真实用户账户拥有的独立 bot 用户，可使用独立
API token 读写被共享的 project/task。当前验证使用 project 作为 workspace 边界；
adapter 自己的 workspace 映射仍需在正式接入设计中实现和验收。

## 基线与范围

| 项 | 值 |
|---|---|
| 容器 | `zterm-vikunja-verify-1103` |
| 仅本机绑定 | `127.0.0.1:12743` |
| API base | `http://127.0.0.1:12743/api/v2` |
| `/api/v2/info` version | `v2.7.1` |
| CLI version | `Vikunja api version v2.7.1 Built with go1.27.3` |
| image repo digest | `vikunja/vikunja@sha256:f7dc8428d10aef17f3075886d3c1c022f566ec456f88985f02c137f4fc534576` |
| image id | `sha256:81d0165f7c9d3523752e9451ff08e18a6cc29c2d287e0f1aa6d77e8f23b5cda3` |
| 临时数据目录 | `/tmp/zterm-vikunja-verify-1103-20261103` |
| 测试 project | A=`3`，B=`4` |
| 采集时间 | `2026-11-03T04:58:48Z` |

遵守边界：未修改生产 Vikunja/Collab、V1 main、全局配置或全局 runtime；未操作
tmux/daemon 生命周期；未使用 broad process kill。

## 证据文件

- 环境与版本：
  `/Volumes/Intel/playground/zterm/.worker-runs/vikunja-adapter-verify-1103/evidence/environment-20261103T045848Z.json`
- 50 条脱敏 API 黑盒记录：
  `/Volumes/Intel/playground/zterm/.worker-runs/vikunja-adapter-verify-1103/evidence/api-matrix-20261103T045848Z.jsonl`
- 可复现采集脚本：
  `/Volumes/Intel/playground/zterm/.worker-runs/vikunja-adapter-verify-1103/collect-evidence.sh`

证据记录中的登录 JWT 和 API token 只保存固定前缀，未保存完整凭据。密码不由脚本
落盘，只通过运行环境注入。

## 结果矩阵

| 能力 | 结论 | 关键证据 |
|---|---|---|
| 目标版本/API 版本 | PASS | `environment-20261103T045848Z.json`；`info.version=v2.7.1` |
| task 创建 | PASS | `task-create`，`POST /projects/3/tasks`，`201`，新 task id=`27` |
| task 查询 | PASS | `task-read`，`GET /tasks/27`，`200`，project=`3` |
| task 优先级更新 | PASS | `task-priority`，`PATCH /tasks/27`，`priority: 41 -> 42` |
| task 关闭 | PASS | `task-close`，`done=true`，`done_at` 为非零时间 |
| task 重开 | PASS | `task-reopen`，`done=false`，`done_at` 回到零值 |
| 评论写入 | PASS | `comment-create`，`POST /tasks/27/comments`，`201`，author=`zterm-verify-a` |
| 评论查询 | PASS | `comment-list`，`GET /tasks/27/comments`，`200`，total=`1` |
| 跨 project 读取拒绝 | PASS | `cross-project-task-read`，B 读 A task，`403` |
| 跨 project 评论拒绝 | PASS | `cross-project-comment`，B 写 A task，`403` |
| 错误密码 | PASS | `login-bad-password`，`403`，`Wrong username or password.` |
| 非法 token | PASS | `invalid-token`，`401`，code=`11` |
| token 创建与使用 | PASS | `api-token-create`，`201`；`api-token-read`，`200` |
| token 撤销 | PASS | `api-token-revoke`，`204`；`api-token-after-revoke`，`401` |
| token 过期 | PASS | `expired-token-create`，`201`；`expired-token-request`，`401` |
| 权限组校验 | PASS | `invalid-token-permission`，错误 group value，`400`，code=`14002` |
| 两个 workspace/project 隔离 | PASS | `workspace-projects-a` 不含 project `4`；`workspace-projects-b` 不含 project `3` |
| 原生 `Idempotency-Key` 去重 | FAIL | 相同 header 和 payload 的两次成功 POST 得到 `29`、`30`；verdict=`FAIL` |
| 真实请求超时后的对账/恢复 | UNVERIFIED | 未触发真实 timeout；两次成功 POST 不是 timeout 测试；adapter 未实现 |
| 分页/排序支撑 top-five | PASS | 关闭 priority `70` 后，`page=1` 返回 5 项且最高为 `60`；`page=2` 返回剩余 `10` |
| 关闭项过滤 | PASS | 无 `done=false` 过滤时 total=`7` 且包含 closed `70`；加过滤后 total=`6` 且不包含它 |
| bot 成员创建与项目共享 | PASS | `bot-create`，bot id=`7`；`bot-project-share`，permission=`1` |
| bot 分配 | PASS | `bot-assign`=`201`；`bot-assignees` 返回 bot id=`7` |
| bot scoped token 操作 | PASS | `bot-read`、`bot-priority`、`bot-close`、`bot-reopen`、`bot-comment` 均为成功 |
| 不要求伪造人类账号 | PASS | bot 由真实用户 A 创建；API/HTTP 黑盒操作均通过 bot-owned token |
| adapter workspace 映射 | UNVERIFIED | 当前只用 Vikunja project 验证隔离，adapter 自身映射尚未实现 |

## 关键黑盒记录

### Task 与评论

代表请求：

```text
POST /api/v2/projects/3/tasks
GET  /api/v2/tasks/27
PATCH /api/v2/tasks/27
POST /api/v2/tasks/27/comments
GET  /api/v2/tasks/27/comments
```

代表结果：

```text
task-create        201  id=27 project_id=3 priority=41 done=false
task-read          200  id=27 project_id=3
task-priority      200  priority=42
task-close         200  done=true, done_at=2026-11-03T04:58:49.464834583Z
task-reopen        200  done=false, done_at=0001-01-01T00:00:00Z
comment-create     201  id=8 author.id=1 author.username=zterm-verify-a
comment-list       200  total=1
```

### 隔离与错误凭据

```text
cross-project-task-read   403
cross-project-comment     403
login-bad-password        403  "Wrong username or password."
invalid-token             401  code=11
api-token-after-revoke    401  code=11
expired-token-request     401  code=11
```

### 原生 Idempotency-Key 与超时对账边界

同一 project、同一 JSON payload、同一 `Idempotency-Key` 连续请求两次：

```text
request 1: POST /api/v2/projects/3/tasks  Idempotency-Key=<same> -> 201, id=29
request 2: POST /api/v2/projects/3/tasks  Idempotency-Key=<same> -> 201, id=30
```

两个返回 task id 不同，因此 black-box verdict 为 `FAIL`，准确含义是“原生
`Idempotency-Key` 不受支持”。官方 `v2.7.1` `pkg/routes/api/v2/tasks.go` 的
create operation 也没有声明与 `Idempotency-Key` 对应的请求处理；这只能作为源码
辅助事实，不能替代上面的 HTTP 黑盒结论。

上面的两次请求都在正常时限内成功返回，所以它们不是“真实请求超时后对账”的测试。
该项保持 UNVERIFIED，直到有真实超时注入和可验证的远端关联机制。

本地 operation record 可以记录已知结果，但单靠一条本地记录和一次空查询不能证明
远端没有提交。若 POST 或评论追加的结果不确定性存在，必须保留 unknown 状态并做
远端查询/人工核实；不能凭相同标题、正文或一次空查询自动重复非幂等写入。自动对账
必须使用经过验证的远端关联机制和可靠终态判定；首期允许显式保留待核实状态。

### 分页与排序

先创建额外 priority=`10` 的测试项，再将 priority=`70` 的 fixture 标记完成。
过滤 `done = false && title ~ "zterm top-five"`，按 `priority desc`、`per_page=5`
查询：

```text
page=1  total=6  ids=[3,4,5,6,7]       priorities=[60,50,40,30,20]
page=2  total=6  ids=[31]              priority=[10]
```

去掉 `done=false` 后：

```text
total=7 包含 closed priority=70，说明过滤条件实际生效，不是空查询。
```

fixture 已重开，额外测试项已删除。

### 成员映射与 bot

```text
POST /api/v2/user/bots                201  id=7 username=bot-zterm-matrix-...
POST /api/v2/projects/3/users         201  permission=1
POST /api/v2/tasks/32/assignees       201  user_id=7
POST /api/v2/tokens                   201  owner_id=7
GET  /api/v2/tasks/32                 200  by bot token
PATCH /api/v2/tasks/32                200  by bot token
POST /api/v2/tasks/32/comments        201  by bot token
```

bot 评论的 author 字段为 bot 用户 id=`7`、username=`bot-zterm-matrix-...`。
bot 没有密码字段，但由真实用户 A 拥有并由 A 创建 token。因此 agent 身份不需要
冒充人类账号；正式接入仍须按 workspace 设计 project 共享与成员映射策略。

## 对 adapter 设计的直接影响

1. 任务创建、评论、状态和优先级可直接映射到 v2 API。
2. token 生命周期可支撑撤销和过期处理，但 adapter 仍需显式处理 `401`。
3. project 权限是实现 workspace 隔离的可用边界；写操作必须处理 `403`。
4. 不能依赖 Vikunja 的 `Idempotency-Key`。创建任务和评论前必须保存本地操作记录，
   超时后先查询对账，只有确认不存在时才重试。
5. top-five 应使用 `filter=done = false`、`sort_by=priority`、`order_by=desc` 和
   `per_page=5`；分页结果按 total 判断是否需要下一批。
6. bot 需要真实 owner 账户，适合作为 adapter 的机器身份；共享 project 后可以让
   bot 使用独立 scoped token 工作。

## 限制

- 本报告是隔离实例的 API 黑盒验证，不是生产 Vikunja 接入完成证明。
- `Idempotency-Key` 的 FAIL 是目标版本的黑盒行为结果；不把一次失败外推为所有部署
  都相同，但已在当前选定镜像 digest 上复现。
- Vikunja 的 workspace 语义没有独立对象；本报告只证明 project 级隔离可用，不能
  冒充 adapter workspace 已实现。
- 评论作者的 email/其他 PII 未采集或保存。

## 官方源码参考

- `https://github.com/go-vikunja/vikunja/tree/v2.7.1`
- `https://raw.githubusercontent.com/go-vikunja/vikunja/v2.7.1/pkg/routes/api/v2/tasks.go`
- `https://raw.githubusercontent.com/go-vikunja/vikunja/v2.7.1/pkg/routes/api/v2/task_comments.go`
- `https://raw.githubusercontent.com/go-vikunja/vikunja/v2.7.1/pkg/routes/api/v2/api_tokens.go`
- `https://raw.githubusercontent.com/go-vikunja/vikunja/v2.7.1/pkg/routes/api/v2/bot_users.go`
- `https://raw.githubusercontent.com/go-vikunja/vikunja/v2.7.1/pkg/routes/api/v2/project_users.go`

## 清理状态

证据落盘并核对后，将只执行：

```sh
docker stop zterm-vikunja-verify-1103
```

该动作只停止本次显式命名的隔离容器；不删除其他容器，不操作生产 Vikunja、Collab、
tmux 或 daemon。
