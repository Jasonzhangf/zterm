# zterm-v2-tickets-impl-1103 P1 rework evidence

从 branch head `120e129c` 起点修正 David 2026-11-03 的 7 项 P1。模块代码只改
`v2/modules/tickets/**`，原始证据只写本目录。

## 证据文件

| 文件 | 内容 |
| --- | --- |
| `red-run.txt` | 新 P1 失败模式测试在**旧实现**（`.tmp-tickets-branch2-1103`，取自 120e129c）上运行，9/9 断言失败。每次断言表达修复后的正确行为。 |
| `green-contract.txt` | 新候选在干净 workspace `5:/workspaces/5`（branch head 129dfede）上的 contract 测试，45/45 pass。 |
| `integration-green.txt` | 真实 Vikunja v2.7.1（容器内 `host.docker.internal:12745/api/v2`）黑盒，2/2 pass：持久 store create/get/report/close/reopen、same-ref 不重 POST、跨 project 403。 |
| `integration-final-head.txt` | 最终 head `12165614` 在真实隔离 Vikunja v2.7.1（12745）上的复跑，2/2 pass。为本次复跑新建 throwaway 用户/project；token 只保留在宿主 `/tmp`，未写入任何提交。 |
| `restart-new-process.txt` | 真正两个 OS 子进程：第一个写 unknown operation 后退出；第二个加载同一文件并 same-ref replay，断言 0 次 create POST。 |
| `vikunja-author-real-report.md` | 原作者真实隔离 Vikunja v2.7.1 证据（12743）原样保留，不修改。 |
| `plan.md` / `integration-real-vikunja*.txt` / `integration-rerun.txt` | 原作者的 plan 与真实/重跑 integration 记录，未修改。 |

`integration-final-unverified.txt` 记录此前一次未注入 token 的 final-head 集成尝试
（UNVERIFIED，exit 1）；随后取得真实 token 后由 `integration-final-head.txt` 闭合。

`red-run.txt` 与 `green-contract.txt` 覆盖了原同名开发期文件：原 `red-run.txt`
是 `ERR_MODULE_NOT_FOUND` 的假红，原 `green-contract.txt` 是旧实现的 31 项测试名。
作者真实 integration 证据未覆盖。

## 每项 finding 的红/绿对应

| P1 | 红测（旧实现失败） | 绿测（新实现通过） |
| --- | --- | --- |
| F1 持久化/重启 | `red-run.txt` F1：新 store 实例重启后 same-ref 重新 POST | `restart-new-process.txt` + contract `persistent store continues binding sequence` |
| F2 binding ID | `red-run.txt` F2：两 service 都分配 binding-1 并覆盖 | contract `two services sharing one store...` / `two workspaces sharing one store...` |
| F3 provider 路由固定 | `red-run.txt` F3：remap 后用新 workspace 的 provider 凭据 | contract `two providers with same task id...` / `workspace mapping change...` / `unavailable fixed provider...` |
| F4 状态并发 | `red-run.txt` F4（两条）：旧 close 晚到覆盖 reopen；unknown appendReport 被 supersede | contract `controllable-delay old close...` / `unknown appendReport...` |
| F5 listPendingWrites scope | `red-run.txt` F5：撤权后仍读取 store 并返回旧 operation | contract `listPendingWrites checks current read scope...` |
| F6 confirmRemoteResult | `red-run.txt` F6：成功 create 可被重绑 | contract `refuses to rebind...` / `refuses a comment already claimed...` |
| F7 cursor/cause | `red-run.txt` F7（两条）：nextCursor 永远空；cause 丢失 | contract `exposes a nextCursor...` / `transport failure ... preserves the cause` |

## 未实现/未验证（见 DESIGN.md）

- 真实超时后的远端副作用核实（只验证 unknown 语义，未用真实网络故障确认 provider 是否执行）。
- 旧超时 PATCH 迟到生效后的 provider 最终状态；本地 intent 不提供远端 fencing，不承诺 exactly-once。
- board/WebUI 与 tickets 的真实组合调用；project-scoped list 的准确 endpoint/filter。
- 生产 Vikunja 部署、凭据轮换、HA、多主写入。
