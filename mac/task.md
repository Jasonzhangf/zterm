# zterm Mac Task Board

## Epic-001 Rewrite truth freeze

- [x] T1 以 Android contract model 重写 Mac spec / architecture / dev-workflow
- [x] T2 建立 `mac/task.md` / `mac/CACHE.md`
- [x] T3 记录本轮第一刀 ownership 切法与验证结论

## Epic-002 App shell first cut

- [x] T1 停止以旧 `ShellWorkspace` 作为主入口
- [ ] T2 建立新的 terminal-first app shell
- [x] T3 建立 minimal launcher / editor / active tab 闭环
- [x] T4 接回真实 runtime 并验证 terminal surface

## Epic-003 Runtime contract cutover

- [x] T1 审计 `mac/src/lib/terminal-runtime.ts` 与 Android 新 contract 的偏差
- [ ] T2 切出 Mac session head / buffer worker adapter（进行中：已接入 head-driven follow sync）
- [ ] T3 让 renderer 只消费新的 projection contract
- [ ] T4 删除旧 workspace/runtime 编排残留

## Epic-004 Desktop capabilities after contract

- [ ] T1 vertical split
- [ ] T2 local tmux
- [ ] T3 schedule modal re-entry
- [ ] T4 packaged smoke closeout
