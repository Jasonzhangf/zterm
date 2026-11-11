# organization-manager-relation-1107 执行结果

## 目标

organization 记录直属管理关系，并对外提供最小可用的 `listDirectReports`
读取端口。Board 不再从 group 层级推导关系，只能消费 organization 的公开结果。

## 当前结果

已完成实现、公开接口测试和 David 定向返工，候选分支
`organization-manager-relation-20261107`，base `f99a61a8`。尚未提交、未集成、
未复审通过。

- member 记录新增可空 `managerMemberId`，organization 是该字段的唯一 owner。
- `addMember` 和 `updateMember` 支持设置 manager；`updateMember` 省略时保留原值，
  传 `null` 清除关系。
- 新增 `listDirectReports({ token, workspaceId, managerMemberId })`，只返回对调用方
  可见的直属成员 ID，并返回当前 workspace revision。
- 设置关系校验 self、沿 manager 指针的环、跨 workspace 未知成员和 allowlist 可见性。
- 删除仍有直属下属的 manager 返回 `MANAGER_HAS_DIRECT_REPORTS`，不静默级联。
- `queryTree` 只按 member allowlist 暴露 `managerMemberId`；不可见 manager 投影为
  `null`，不泄漏其 ID。
- 定向返工补充两项授权/投影修复：旧 manager 隐藏时，清除或改派关系返回
  typed `ORGANIZATION_FORBIDDEN`，relation 和 revision 均不变；省略
  `managerMemberId` 的 name/group 更新保留授权更新能力，成功 receipt 使用
  同一 allowlist 可见性投影，不泄漏隐藏 manager ID，但持久关系不变。
- 最新定向修复：隐藏旧 manager 的 clear/reassign 拒绝文案改为通用
  `member relation update is not allowed`，不插入私有 oldManagerId；公开
  error message、record、details、cause 均不含隐藏 ID，code 仍为
  `ORGANIZATION_FORBIDDEN`，relation 和 workspace revision 不变。
- 新增 `MANAGER_HAS_DIRECT_REPORTS` typed error 和 terminal retry disposition。
- 新增 member-manager assignment 写路径图和 manager-direct-reports 读路径图。

## 范围

只修改 `v2/modules/organization/**` 和 `v2/evidence/organization-manager-relation-1107/**`。
未改 Board 消费侧、members、routing、daemon、webui 或 connections。

## 证据

- 红测：`v2/evidence/organization-manager-relation-1107/red-manager-relation.txt`
  （4/4 fail，当时端口和校验缺失）。
- manager 聚焦测试：`v2/evidence/organization-manager-relation-1107/green-manager-relation.txt`
  （5/5 pass）。
- organization 既有测试：`v2/evidence/organization-manager-relation-1107/organization-tests.txt`
  （16/16 pass）。
- 公开 self-check：`v2/evidence/organization-manager-relation-1107/self-check.txt`
  （`organization-receipt-ok`）。
- DAG 校验：`v2/evidence/organization-manager-relation-1107/dagpipe-validate.txt`
  （两张图 validate 和 inspect 均 exit 0）。
- 变更路径：`v2/evidence/organization-manager-relation-1107/changed-paths.txt`。
- 返工红测：`v2/evidence/organization-manager-relation-1107/red-old-manager-hidden.txt`
  （两条新增用例在修复前分别失败）。
- 返工绿测：`v2/evidence/organization-manager-relation-1107/green-manager-relation-rework.txt`
  （7/7 pass）。
- 返工回归：`v2/evidence/organization-manager-relation-1107/organization-tests-rework.txt`
  （16/16 pass）。
- 拒绝文案红测：`v2/evidence/organization-manager-relation-1107/red-hidden-manager-message.txt`
  （修复前公开 error message 包含隐藏 manager ID）。
- 拒绝文案目标绿测：`v2/evidence/organization-manager-relation-1107/green-hidden-manager-message.txt`。
- 拒绝文案全量 manager 用例：`v2/evidence/organization-manager-relation-1107/green-manager-relation-message.txt`
  （7/7 pass）。
- organization 模块回归：`v2/evidence/organization-manager-relation-1107/organization-tests-message.txt`
  （16/16 pass）。
- 语法检查：`v2/evidence/organization-manager-relation-1107/node-check-message.txt`
  （exit 0，无输出）。
- 公开 self-check：`v2/evidence/organization-manager-relation-1107/self-check-message.txt`
  （`organization-receipt-ok`）。

## 边界

这是公开 service 接口级黑盒证据，不是 Board 集成、HTTP/WebUI、生产 daemon 或
Android 真机交付。独立 review、集成和远端交付留给对应 owner。
