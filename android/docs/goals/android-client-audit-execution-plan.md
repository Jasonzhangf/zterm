# Android 审计完整执行计划

## 目标与真源

完整执行 `../audits/2026-09-05-android-client-gap-audit.md` 的 A1–A10、U1–U6 及相关 AGENTS/skill 修复，交付可运行、已验收、已合并的 Android 客户端。不得把审计报告、测试更新、单个切片或 APK 启动当成整体完成。

目标架构以 `../decisions/2026-09-05-runtime-memory-truth.md`、`../architecture.md`、`../audits/2026-07-02-architecture-boundary-remediation.md` 及适用 decision/registry 为准。执行遵守项目 AGENTS、mobile skill、dev-workflow 和共享 review 标准；本计划不复制它们的详细规则。

## 基线与既有交付

计划建立时已核验 origin/main=`804563aa73de57b5752c061c1bc5303f18b9c82a`；启动执行时重新 fetch，不能把这个 SHA 当成永远最新。

- PR42：审计与规则修复已合并。
- PR43：file-browser session port、上传固定 sender、关闭会话后 retained-tab 绑定修复已合并；仅 A2/A3 首个子项。
- PR44：两份中文 accessibility 测试契约修复已合并，6 项测试、AGY、六项 CI 通过；真实键盘/设备/TalkBack 未验收，U6 未关闭。
- `zterm-1` 已本人注册 `android-download-store-a3`，状态 working；树 `playground/android-download-store-a3`，分支 `refactor/android-download-store-a3`，基线 `8db8ae96`。
- `dsh-plugins-1` 的 `android-accessibility-u6` 已本人登记 merged，cleanup pending；树 `playground/android-accessibility-u6`。下一任务优先完成 U6 实际交互证据，再推进独立 UI 项。

这些状态是执行入口，不重新实现已合并切片。规划文档当前位于独立树 `playground/android-audit-execution-plan`，分支 `docs/android-audit-execution-plan`；执行启动时先审核并纳入主线，使后续 worker 从主线读取。

## 责任与调度

- `zterm-3` 为协调者：整体依赖计划、任务拆分发放、文件边界、worktree 分配、验收、AGY review、commit/push/PR/合并、主线核验，以及回收组织和回收凭据核验。协调者不编写产品实现补丁。
- 已有 worker 负责实现和实现验证：`zterm-1` 优先业务/架构，`dsh-plugins-1` 优先 UI/无障碍；按实际空闲、能力和依赖重新分配，不以 worker 名称推断项目或在线状态。
- 复用已存在的 Collab peer；重启后在正确继承项目中 `appsdk init .`，核验本人身份与唯一有效默认 direct-message 订阅。不要擅自创建替身或伪造身份。
- 一个切片一个实现 owner、一个独占 clean worktree、准确基线及 allowed/forbidden paths。worker 本人维护任务状态；协调者按用户授权负责 Git 集成，不冒用 peer 改任务真相。
- 每次收件读取 durable body、核对 diff/证据/状态，决定验收、退回、拆小、解除依赖或发下一任务。不止 ACK；也不把通知发送或 working 状态当成已完成。
- 验收失败发出具体失败条件与最小修复范围，保留原 owner 和现场。被阻塞任务记录外部条件，同时推进无依赖任务；涉及文件或设备重叠先协调互斥，不强行并行。
- 协调者维护本计划的执行台账；worker 使用任务独占 notes，不并发写全局交接。每次交付记录审计 ID、owner、task、base/commit、测试/review/实际流程、PR/main、剩余项及 cleanup。

## 切片、技术方向与验证矩阵

文件为定位入口，不是任意修改授权；每个子任务须先核对当前代码、feature/resource/module/edge 归属，再冻结准确文件清单。

| 项 | 方案与主要入口 | 必须证明 |
| --- | --- | --- |
| A2/A3/A10 | App、TerminalPage、plugin-file-browser、FileTransferSheet、file-transfer-session-runtime；typed intent/snapshot 与能力端口，下沉业务和 native I/O，移除视图旧实现 | 切会话不串目的地；close/reopen/unmount 生命周期；取消/断线/落盘失败不完成；字节/hash、最终 stat、ACK 有界；UI 单独挂载不启动业务；动态效果验证而非只检 wrapper |
| A4/A10 | plugin-remote-window、RemoteWindowOverlayController、既有 stream runtime；业务 owner 持有 stream 生命周期，UI 保留布局/焦点 | single-flight、晚到结果、ACK/关闭、真实 decoded frame、资源清理；不得恢复双启动链 |
| A1 | App、composition-root/plugin-host/control-center、packages/kernel/cordis；按目标以 Cordis 接管生产生命周期并删除旧链 | 实际生产组合入口、start/stop/dispose、缺能力/失败、重复调用；正文不经过控制容器；无两套 owner |
| A5 | AndroidConnectionService、客户端 service runtime、traversal/shared route contracts | LAN→UDP→Tailscale→Relay；IPv4/IPv6 同 tier；前后台/网络切换/断线恢复与健康路径；native 唯一路由 owner，UI 不决定重连 |
| A6 | shared mobile-config/bridge-settings、session-buffer-store | 默认 3000 且可配置，容量边界独立；淘汰、稀疏洞、同绝对行更新与重连缓存 |
| A7 | mirror writer/store/publisher、viewport 请求规划 | wire 实测 head/tail 后首发≤三屏；普通末屏比较、TUI 原地变更、历史按需修复；读请求不触发上游同步策略 |
| A8 | daemon/config、traversal-relay-client、既有配置 owner | 合法/损坏/中断 JSON→TOML 原子迁移与 read-back；迁移后单真源、缺配置显式失败；不擅自决定认证方案 |
| A9 | TerminalView、既有 renderer-window hook/owner | follow/reading/IME/可见范围、同绝对行 patch、frame 一次 commit；DOM 不重建窗口策略 |
| U1/U2/U3 | terminal shell layout、资源入口、QuickBar 与现有 density/theme tokens | 手机/平板、窄屏/IME/拖动入口不碰撞、命中区域不重叠、正文空间；保留自定义命令、常用一行次级渐进展开 |
| U4/U5 | Settings/Connections 及实际文字 owner | 中文任务文案、技术信息高级展示、长名称识别与详情、错误/保存真相；协议值不因文案改变 |
| U6 | ConnectionsPage/SettingsPage accessibility 与真实应用入口 | 中文可访问名、真实键盘焦点/顺序与反馈、TalkBack、手机/平板；jsdom focus 和测试绿不能代替设备验收 |
| 规则 | AGENTS、mobile/terminal skill、受影响 maps/workflow | 消除本次触及的旧规则冲突与双真源；项目事实/流程归唯一 owner，不把历史经验恢复为目标架构 |

## 执行顺序与适应

1. 恢复主线、worker/任务/订阅和已有证据；审核合入本计划；建立覆盖全部审计 ID 的台账。
2. 继续 zterm-1 A3 下载 native 落盘事务；dsh-plugins-1 完成 U6 真入口验证及后续独立 UI 切片。与其他现有 worker 的旧任务先查冲突，不接管。
3. 按真实调用依赖推进 A2/A3/A4/A9 与动态边界 gate A10；端口稳定后迁移 A1，禁止以新框架包旧链冒充解耦。
4. A5/A6/A7/A8 各自独立切片；连接、缓存、publisher 与配置修改有共享 owner 时串行集成。U1–U5 在相应业务边界稳定后并行推进。
5. 每个切片完成即验收→review→commit→PR/相关 CI→merge→核验 main；不在 main 编码。基线变化只补受影响验证，复用仍有效证据。docs 免 CI 授权不得扩大到代码。
6. 按实际结果更新依赖与下一任务，直至全部 ID 有证据关闭；不能因首个 PR 成功停止。任何缩减验收或保留目标差距必须由用户明确接受，不能自行把未完成改成 advisory。
7. 最终在精确合并版本跑 Android/daemon 主流程、手机/平板/IME/错误与弱网流程，保留代码→产物→设备证据链。构建/安装/OTA/生产变更按适用项目契约和已有授权；需额外授权时先准备具体可审阅交付物，再仅询问真正缺失的授权。

## 风险控制与完成定义

- 防假解耦：审查业务效果和生命周期的实际 owner，物理删除已替代旧实现，不只搬文件、加 hook 或改字符串测试。
- 防证据混用：PR/CI、构建、安装/启动、真实请求/设备回放分别记录。未运行的场景明确 open，不用 mock 或旧 APK 顶替。
- 防并发损坏：共享 registry、main 集成、设备和本地 daemon 按实际资源协调；只停止显式归属 PID/服务，不批量 kill/reset/clean。
- 回收纳入任务闭环：本 goal 的已合并树在证据存入可保留位置、无未提交/未合并/唯一历史、无活跃进程/claim 后，由协调者安排 owner 按 Collab 协议清理并取得 receipt，再验实际路径已移除和任务 closed。任务必要进程只做明确归属清理。旧任务/他人树/未合并工作不因本 goal 批量回收；需保留则写清 owner、原因和释放条件。
- 最终完成：A1–A10、U1–U6 每项满足对应验收或获得用户明确接受；实际 UI 和数据主链通过；代码/规则已合并并核验远端 main；每个本 goal 任务有工程与资源两份闭环状态。缺真实设备/权限等外部条件时报告精确阻塞并推进其余工作，不能宣称整体完成。

## 执行台账（协调者单 owner 追加）

2026-09-06：计划建立。PR42/43/44 已合并；完整审计仍 open。A3 `android-download-store-a3` working；U6 测试子项 merged/cleanup pending。后续每条记录关联审计 ID、task、提交与证据，不改写历史记录。
