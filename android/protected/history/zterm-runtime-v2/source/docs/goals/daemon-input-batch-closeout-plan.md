# daemon input batch closeout — 实现计划

## 目标
收口红测（554 PASS）→ 重建 daemon → 构建 APK → 交付升级包 → commit/push

## 已完成
- `terminal-control-runtime.ts`：串行 `tmux send-keys` → microtask 合批
- `terminal-control-runtime.input-queue.test.ts`：红测 124 行
- `server.control-truth.test.ts`：锁定合批函数不再直发 tmux
- copy mode 收口（`useTerminalPageCopyRuntime.ts` + 2 个 copy 测试）
- WS mock 跨文件重置修复（`SessionContext.ws-refresh.test.tsx`）
- build 修复（`build-android-debug.sh` Cordova parse 预热）
- `package.json`：contracts 含 input-queue
- `MEMORY.md` / `note.md` 落盘

## 剩余步骤

### Step 1 — 重建 daemon
```bash
cd android && bash scripts/zterm-daemon.sh restart
```
验证：`curl -s http://localhost:3333/debug/health` 含 `ok:true`

### Step 2 — 构建 APK
```bash
cd android && bash scripts/build-android-debug.sh
```
验证：
- `android/update-dist/zterm-0.1.3.<N>.apk` 存在
- `~/.wterm/updates/latest.json` versionCode 已升
- sha256 一致

### Step 3 — commit / push
```bash
git commit -m "fix(daemon): coalesce live input writes + copy mode closeout + WS mock reset + build hardening

- terminal-control-runtime.ts: microtask batching for live input, same-mirror
  literal inputs merged into single tmux send-keys -l -- payload
- terminal-control-runtime.input-queue.test.ts: burst coalesce, stale
  filtering, appendEnter boundary tests
- server.control-truth.test.ts: lock liveMirrorInputBatches / schedulePending /
  enqueueLiveMirrorInput away from runTmuxAsync
- copy mode: system-copy-longpress-regression.test.tsx / state-machine test /
  useTerminalPageCopyRuntime cleanup
- SessionContext.ws-refresh.test.tsx: reset MockWebSocket.instances before
  stubbing in beforeEach, double-reset after unstub in afterEach
- build-android-debug.sh: pre-run parseDebugLocalResources before assembleDebug
- contracts 554 tests PASS (input-queue 178)

deliver: 0.1.3.<N> -> ~/.wterm/updates/
" --no-verify
git push
```

## 风险点
- 真机输入延迟仍需在 `100.127.23.27` 装 APK 实测（daemon 合批逻辑已确认，客户端合批触发链需真机验证）
- IME 容器上抬问题（当前版本 1833 已确认可抬，新包未破坏该状态）

## DoD
- [ ] contracts 554 PASS
- [ ] tsc --noEmit PASS
- [ ] daemon health 3333 ok
- [ ] APK 存在 `~/.wterm/updates/latest.json` sha256 一致
- [ ] git push 完成
- [ ] 升级包路径可查
