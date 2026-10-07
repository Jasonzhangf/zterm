# zterm 逐项治理 Goal 计划

日期：2026-10-04。状态：ACTIVE / 基线复核与能力确认。
编排者：当前 Codex 主任务。执行者：新建 `codex exec --profile gcm` worker。
计划 owner：编排者；worker 不改本计划的状态表或共享治理文件。

## 1. 目标与范围

逐项治理 2026-10-04 前端/架构审计 A01–A15，完成注册登录、同账号多 daemon
发现与连接、所有用户可访问的统一更新、完整人类交互和入口拓扑、资源生命周期、
计算及 I/O 优化。每项必须经作者验证、真实入口验收和独立架构 review，再串行
集成到 main 并核对 origin/main。计划、代码候选、单测或 APK 启动均不等于交付。

范围：Android 主线、daemon、Relay、公共发布渠道、相关 shared contract；Mac/Windows
当前声明支持的入口须检查一致性，并按各自真实宿主验收。缺失支持列为具体 gap，
不能用 Android PASS 冒充其他客户端完成。wterm runtime 问题回其 owner，不内嵌源码。

非目标：会员计费、全新客户端产品、改变路线优先级、终端正文语义、全局规则/Skill
重写、接管他人 stream 任务、生产账号数据重置、权限清除、全局 MCPX/Collab 重启。

## 2. 事实与规则真源

- 审计参考基线：e27780bab048f1b799a3c3d899a423b38dd92b84。
- 本轮 fetch 后基线：bc4a26a93c6c3d60bd8aebe3507e8c776a71c18c。
- 共享主树 /Volumes/extension/code/zterm 有他人 Skill dirty；不得覆盖、stash 或清理。
- 启动与 merge 边界刷新 origin/main；旧审计结论必须按新基线复核，不机械补 patch。
- 全局 /Users/fanzhang/.agents/AGENTS.md、各 worktree AGENTS.md、
  android/docs/architecture.md、architecture-boundary-remediation、runtime-memory-truth、
  android/docs/dev-workflow.md、受影响 DAG、registry 与项目开发 Skill 为执行真源。
- 编排：/Users/fanzhang/.agents/skills/codex-orchestrator/SKILL.md 及 worker-contract.md。
- DAG：/Users/fanzhang/.agents/skills/dagpipe-runtime/SKILL.md。
- 作者验证与黑盒：coding-principals；独立审查：codex-review/review-standards.md。
- MCPX 已发现，但 Runtime 尚无这些新 worktree；不得为注册重启他人共享 MCPX。
  worktree 专属 MCPX 能力未就绪时，按 Skill 允许的宿主 CLI 回退，记录事实。

## 3. 控制与证据位置

- 编排工作树：/Volumes/Intel/playground/zterm/item-governance-1004，
  branch codex/item-governance-1004。
- 运行记录：/Volumes/Intel/playground/zterm/item-governance-1004-control。
- 编排节点笔记：该 control 目录 controller-notes.md；每项节点在完成/失败/阻塞时记录
  时间/节点｜结论/状态｜证据路径｜输入版本/必要环境｜下一步。
- 子任务合同、worker JSONL、最终回报、真实 PID/session、证据目录在 control 各 lane 下。
- worker 只写自己的节点笔记；编排者独占 board.json 与集成/资源租约记录。
- 版本化设计在各 worktree android/docs/goals/governance-1004/<lane>.md；
  复用并修订项目已有 graph，不能以聊天图代替 graph 产物。
- 不写长期记忆，不提交 APK、大日志、node_modules 或 credentials。

## 4. 审计项账本

所有项初始 REVALIDATE。只有当前源码/真实入口证明仍存在，才进入修复；
已由新 main 修复的项以候选绑定的回归证据验收，不能重复实现。

| ID | 目标 | 主 owner/lane | 必要黑盒结果 |
|---|---|---|---|
| A01 | Android 用户注册入口 | account | 新注册、重复用户名、登录失败结果可区分且输入保留 |
| A02 | Relay 配置单源、daemon 账号入网 | account | 自定义服务配置一致；迁移无数据损失；稳定机器身份 |
| A03 | token/账号 generation/退出撤销 | account | 同账号多设备不互踢；退出后迟到刷新不复活；重连 token 有界 |
| A04 | 权威公共更新与连接路线分离 | update | 两账号及未连接 daemon 的客户端看到同一发布版本 |
| A05 | 发布原子切换 | update | 包未完整验证不能公布；中断保留旧清单 |
| A06 | 安装结果真实性 | update | 取消/拒绝不完成、不跳过；实际版本匹配才完成 |
| A07 | 升级中间状态/单飞/取消 | update | 慢网状态可见、重复点击不并发、取消终态明确 |
| A08 | 返回/弹层/草稿/焦点闭环 | ui | 返回来源、最上层关闭、草稿处理、焦点恢复 |
| A09 | 人类信息与入口拓扑 | ui（账号表单属 account） | 默认不要求清单 URL/Daemon ID；状态不被“当前”覆盖 |
| A10 | 上传/粘贴/目录 dispose 生命周期 | files | 完成/失败/取消/断连/超时/shutdown 回收所属资源 |
| A11 | APK 缓存生命周期 | update | 下载/哈希错误无孤儿；待安装/回退保留规则明确 |
| A12 | 文件内存和 I/O 有界 | files | 大文件哈希正确，内存受窗口约束，终端不中断 |
| A13 | Relay 持久化/广播/认证热点 | account（独立后续切片） | 认证不全量同步重写；在线数据有界；admission 明确 |
| A14 | 在线事实与历史连接分离 | account | 历史成功不证明当前在线；半开/失联显式 |
| A15 | 终端采集计算与低延迟契约 | terminal | top/vim/静默突发/历史正确；健康订阅不靠静默降频掩盖成本 |

## 5. DAG 与执行状态

每项独立流：
待复核 → 能力确认与复现 → 设计图闭环 → 独立设计 PASS（未知能力项强制）
→ 最小红测 → 唯一 owner 修复 → 定向测试 → 最新 main 组合候选
→ 适用产物/安装/真实黑盒 → 独立架构 PASS → main 集成/远端回执 → 资源回收 → DONE。

失败、取消、阻塞均落盘，不冒充成功。重试新 attempt；只失效变化的节点。
实现前写清对应 graph、唯一 owner、补链/修图/物理移除/显式兼容保留、必跑 gate。
terminal 切片严格先受影响 docs/规则契约、测试、代码；不碰他人 Skill dirty。
终态资料齐全之前不得启动实现后的架构 review。

### 本轮并发入口

首轮五个 GCM worker 并发做基线复核、能力确认、最小复现、设计与测试合同，
产出各自设计文档和所需 graph 修订。首轮禁止产品代码修改、共享 runtime 动作和 merge。
设计 reviewer 独立于作者；设计通过后编排者逐 lane 发新的实施合同并开放 allowlist。
已证明完整的旧图/能力复用，不为了流程重复设计或重复验收。

- account → 账号主线优先，A13 热点在账号主线可用后做。
- update → 与 account 并行设计；公共渠道不得依赖账号登录成功或 daemon 连接。
- files → 与前两者并行设计；shutdown server.ts 接线由编排者独占集成切片处理。
- ui → 可独立处理导航/信息；账号表单和更新组件由对应 lane 持有，不能双写。
- terminal → 独立确认性能基准；不与当前他人媒体/stream 任务混写或争设备。

## 6. 文件所有权与资源租约

| Lane | Worktree/branch | 设计写入 | 实施候选范围（由批准合同细化） |
|---|---|---|---|
| account | /Volumes/Intel/playground/zterm/govern-account-1004 / codex/govern-account-1004 | governance-1004/account.md；relay-account-peer-route graph | traversal-relay store/server；server/relay-client；traversal-relay-client；account hook/stream/presence；ConnectionConfigSection；daemon Relay CLI |
| update | /Volumes/Intel/playground/zterm/govern-update-1004 / codex/govern-update-1004 | governance-1004/update.md；release-update-lifecycle graph | app-update runtime/hook/preferences；AppUpdateSection；AppUpdatePlugin.java；发布与 bundle 脚本 |
| files | /Volumes/Intel/playground/zterm/govern-files-1004 / codex/govern-files-1004 | governance-1004/files.md；daemon-file-transfer upload/download/browse graphs | terminal-file-transfer owners、契约与 consumer；不写 server.ts |
| ui | /Volumes/Intel/playground/zterm/govern-ui-1004 / codex/govern-ui-1004 | governance-1004/ui.md；android-session-shell-lifecycle graph | 页面状态/返回、Connections、Settings 组合、调度与弹层；不写 account/update owner 文件 |
| terminal | /Volumes/Intel/playground/zterm/govern-terminal-1004 / codex/govern-terminal-1004 | governance-1004/terminal.md；daemon-mirror-publish graph | mirror writer/runtime/publisher 与性能 consumer；不写媒体/stream owner |
| controller | item-governance-1004 | 总计划、账本、共享 registry、相邻图协调 | App.tsx/server.ts/shared 注册接线；逐项集成、产物、设备、OTA、review |

worker 不同时写 App.tsx、server.ts、registry/package.json、buildNumber 或共享证据。
需要共享改动时返回精确 patch/合同，编排者开独占集成节点执行。
daemon 安装/重启、APK/OTA/设备、公共发布和 main push 使用编排者串行租约；
worker 不自行取得或覆盖租约。生产账号操作不在测试路径中；用隔离测试账号与实例。
未来模块合同若 overlap，先拆依赖或顺序执行，不能平均切工作或两人写同范围。

## 7. 测试与真实入口证据

现有 gate 先核对 package.json，再使用：
- 全局基础：pnpm --dir android run type-check；受影响 feature/resource/module/import gates。
- account：test:relay:account-directory、Relay store/server 与 hook 的定向测试；
  隔离 Relay HTTP/WS 两账号两 daemon 两 client consumer，及安装客户端实际账号路径。
- update：app-update runtime/hook/native 契约测试；隔离更新 HTTP 服务，发布中断与哈希；
  系统安装器取消/拒绝/成功的 emulator+指定真机版本回读。
- files：file-transfer owner 定向测试；真实公开协议上传/下载、字节数/哈希、
  累计 ACK/中断/并发/cleanup；实测 RSS 与终端响应，不以 mock 内部调用验收。
- ui：页面/导航/弹层定向测试；真实 WebView 触摸、返回、键盘、长名称、空/加载/错误；
  保存 viewport、截图、logcat、buildNumber、包 hash。
- terminal：mirror/capture/publisher 定向门禁；同入口 top/vim、静默后输出、
  多订阅/慢订阅与滚动历史；记录输入到画面延迟、CPU、RSS、采集窗口/命令量。
- Mac/Windows：受影响真实 Electron/宿主入口；无设备/能力时具体 UNVERIFIED，不宣称全端完成。

Android 产物只走 pnpm --dir android run build:android；构建分配版本、normal/rollback 包
及本地 OTA，不可当只读检查。编排者在真实验证节点统筹设备和包身份；
指定真机缺失要查当前工具/连接能力，不能拿 emulator 替代指定真机或跳过 L5。
daemon 变更由候选重建并安装到稳定实际入口、服务级重启、loaded binary/PID/hash、
同入口成功/失败回放证明。测试进程只能本任务创建并用精确 PID 回收。

## 8. 逐项 merge 合同

每次只放行已验收项目切片；只修同 owner 的必要相邻缺口，不为凑一项混入未验项。
1. fetch 最新 origin/main，组合候选；有冲突停止受影响集成，编排者裁定语义后再验。
2. 记录候选 SHA/tree、定向测试、必要构建、产物 hash/版本、安装/重启、
   OTA manifest、真实成功/失败/取消/副作用、架构 review PASS。
3. 独立 reviewer 用 codex-review；milestone 显式 oauth + gpt-6.1-sol；
   普通按全局路由，FAIL 返回作者，修复重验新候选，禁止作者自审自过。
4. merge 前复查 main；变化只重跑受影响测试/E2E/review；检查项目正式集成锁与 hooks。
5. 在 clean 集成位置按项目 Git/受保护 main 的正式路径集成；不强推、不绕 hook。
   主树 dirty 不授权清理；若受保护 main 要 PR/checks，沿正式路径完成。
   当前 `.githooks` 明确拒绝 main commit/direct push：使用已验 owner 分支的
   hook 校验 push、正式 PR、CI/checks 与 GitHub merge；不能因远端未启用
   branch protection 而绕过项目 hook。合并后 fetch 核对远端 main/tree。
6. 核对 main 内容与已验候选等价，origin/main 回执与 CI；记录最终 SHA。
7. 合并引发本地回归执行既有恢复 DAG，以 git revert 保留历史。
8. 最后按 owner 清理本轮资源；未完成项留待恢复，不删除 dirty/他人 worktree。

每项收口账本必填：
ID｜base｜candidate/tree｜测试/E2E｜artifact/version/hash｜runtime/OTA｜
review/controller｜main/remote receipt｜cleanup｜最终状态。
适用字段缺失即 INCOMPLETE/UNVERIFIED，不把候选、PASS 或本地 merge 当 DONE。

## 9. 阶段顺序与完成条件

阶段一：account 注册/配置/会话/目录及 update 权威渠道/安装闭环。
阶段二：ui 入口/返回/信息与 files 生命周期/流式 I/O。
阶段三：account A13 和 terminal A15 性能，使用主线可用后的真实基准。
阶段间主线优先；独立设计/准备可并行，集成与共享运行态串行。

Goal 完成 iff：
- A01–A15 每项已在新基线验证并解决或有“现已修复”的真实回归证据；
- 用户七项目标全部有实际可用路径，支持客户端的缺口已处理；
- 每项适用作者验证、独立 review、main/远端/产物/runtime/OTA 证据齐全；
- 清理自有 worktree/进程/forward/临时包与任务目录，保留精简交付记录；
- 编排者给出逐项交付账本，不以总体测试绿覆盖单项缺证据。
