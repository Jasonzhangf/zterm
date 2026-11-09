# P1-3 结果：活连接下 accounts grant 与 machine 撤销的终端拒绝（zero side effects）

任务：daemon-terminal-admission-1107 / terminal-admission-composition-1107，P1-3（composition-rework-20261108）
状态：代码改完 + 黑盒探针复验通过；残余：Mia review 与 P1-2 等待；任务工作范围未 push/merge/publish/PR。

## 受命行动
按裁决 m1794144335550-2363：P1-3 用支持的 `startDaemon` 入口 + 真实 owners 独立交付，验证活连接下撤销 accounts grant 的 typed refusal 与零新 channel/input 副作用；再验证机器撤销。禁止改公共契约，不动共享端口/tmux。

## 探针环境（真实，未碰共享资源）
- isolated-v1 fixture `isolated-v1-28147-mw7sco4k`，运行中：port 57324，V1 daemon PID 28223，tmux server PID 28186，socket `/tmp/isolated-v1-28147-mw7sco4k/tmux.sock`，alpha `fixture-alpha-28147`（`$0`），`daemonHostId=daemon-Macstudio-2.local-e77d4c1116506598`。
- 探针端口/临时目录已全部释放；未启动/关闭任何共享 daemon，未 push/merge/publish/PR。
- 公共契约未改动。

## 探针代码改动（范围：v2/modules/daemon 仅三文件）
1. `v2/modules/daemon/src/machine-terminal-consumer.mjs`
   - `createConnectionMachineTerminal` 新增可选 `authorizationPort`；`forMachine` 在复用/返回前先调 `authorizationPort.authorizeMachine(machineId)`；失败抛出带 `owningModule="accounts"` 的 typed error（`MACHINE_REVOKED`/`WORKSPACE_AUTHORIZATION_REQUIRED` 等）。
   - 根因：撤销机器/授权后，缓存机器 link 仍作为 connected/fresh 被复用，导致下一次 stream/input 返回 200 且打开新 channel/input。改为在每次 `forMachine` 边界重新做账号层机器授权检查，拒绝在 channel/输入写之前。
2. `v2/modules/daemon/src/server.mjs`
   - `withTerminalAdmission` 对 module-carried typed error 保留原 `owningModule`（不再统一包成 `daemon`），并把 `WORKSPACE_AUTHORIZATION_REQUIRED`、`WORKSPACE_FORBIDDEN`、`MACHINE_REVOKED` 映射 403、`MACHINE_NOT_FOUND` 映射 404。
3. `v2/modules/daemon/src/terminal-admission.mjs`
   - `translateAdmissionError` 对 `AccountsError` 与携带 `owningModule` 的 typed error 保留所属模块，让 HTTP 边界传出 accounts-owned typed refusal，不再 collapse 为 `DAEMON_REQUEST_FAILED/daemon/500`。

## 探针结果 p13-result.json（原始，未篡改）
- host-producer 绑定：`stableId` 含 `socketPath`，catalog `stableId` 不含，`equal=false`，daemon 返回 `TERMINAL_TARGET_BINDING_UNAVAILABLE 424`，`acceptedByDaemon=false`。这是已知稳态 stableId gap（见“对齐方案”），不阻塞 revocation 正例：正例先由 members（无 host probe）按 catalog identity 绑定成功。
- 正例 stream/input：HTTP 200，`bindingGeneration=2`，`channelOpens=1`→`2`，`inputWrites=0`→`1`（正例内期望的唯一一次输入）。
- Grant 撤销后：stream/input 均 403 `WORKSPACE_AUTHORIZATION_REQUIRED`，`owningModule=accounts`；direct admission 同样返回 `WORKSPACE_AUTHORIZATION_REQUIRED`/`owningModule=accounts`（该层不写 HTTP status）；副作用保持 `channelOpens=2/inputWrites=1`，零新 channel/input。
- Machine 撤销后：stream/input 均 403 `MACHINE_REVOKED`，`owningModule=accounts`；副作用保持 `channelOpens=2/inputWrites=1`，零新 channel/input；live transport 观测仍 connected/fresh（撤销只关闭授权，不拆已建物理连接）。
- 运行一次，退出码 0，受影响单测全部通过（`terminal-admission.test.mjs` 20/20，`machine-terminal-consumer.test.mjs` 9/9，`terminal-admission-fail-closed.test.mjs` 2/2）。

## 残余缺口
1. P1-2（真实 committed body frame + 唯一非回显命令输出）需等 Leo 的 `terminal-admission-startup-config-20261108` 候选合并后再做；此项未开工。
2. P1-3 未交付审查：等待 Mia formal review 与 Jenny 回报。

## 对齐方案（host producer stableId vs live V1 catalog，由 result.md 记录，供 Mia review 判定）
- 缺陷：`createTmuxHostProbe` 产生的 `stableId` 里塞入 `socketPath`；live V1 catalog 登记的 `stableId` 是 `{backend, serverPid, sessionId, createdAt}`，不含 `socketPath`；二者不 exact-match，`resolveBindingTarget` 拒绝，导致 host-producer 目标不可解析。
- 原因：`socketPath` 是本次会话的传输定位信息，不是 tmux 会话的稳定身份；同一 session 重启/迁移 socket 会变，把它写进 stableId 会破坏 exact catalog 匹配和 reauth。
- 方案（推荐）：由 host-adapter 层 `createTmuxHostProbe.buildTmuxStableId` 去掉 `socketPath`，与 catalog 登记的字段保持一致；catalog 不改，不接收含 `socketPath` 的稳态标识；host producer 与 catalog exact-match。
- 替代方案（不推荐）：catalog 接收含 `socketPath` 的稳态 stableId。理由：将传输定位混入会话身份，违反 catalog/backend/stableId 分离，且会让跨 socket 的同一会话出现两份身份。
- 实施边界：host-adapter 属 Leo/P1-1 或独立 owner，P1-3 composition owner 不改该层代码；本改动仅记录方案，等 owner 实施后回归验证。

## 任务工作路径/分支
Worktree `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`，branch `daemon-terminal-admission-20261107`；证据目录 `v2/evidence/daemon-terminal-admission-1107/composition-rework-20261108/`。
