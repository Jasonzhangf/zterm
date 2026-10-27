# zterm Mac Dev Workflow

## 总原则

- 先确认受影响流程和唯一 owner，再改实现
- Mac 只补平台壳，不另起 terminal 真相
- 先切入口 ownership，再切 deeper runtime
- 无运行态证据，不向 Jason 宣称“可以手测完整版”

## 开发与验证

通用流程沿全局 `coding-principals`。只更新本次改变的规格、owner 和验收契约；不为每个切片同步整组 spec、task、CACHE 和 workflow。历史 rewrite 的切片限制不作为后续所有任务的准入条件。

源码改动按影响选择测试与类型检查；编译或 bundle 行为改变时再运行构建：

```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

若改到 Electron shell / packaged 行为，再补：

```bash
pnpm --filter @zterm/mac package
```

### 主进程 shared 包消费契约

`mac build:main` 用 `tsc`（`module: NodeNext`）单独编译 `mac/electron/`，产物不打包；主进程运行期（Electron 31 / Node 20.18）不加载 TypeScript。因此主进程静态导入的任何 `@zterm/*` 包必须满足：

- 包有构建产物（`tsc` 输出 `dist/*.js`），`exports` 条件 `import` 指向 `dist`、`types` 指向源 `.ts`；
- `package.json` 声明 `prepare` 脚本，fresh install 即产出 `dist`；
- electron-builder `files` 显式把包与 `package.json` 带进 app（workspace 软链不被 builder 跟随）。

当前满足该契约的主进程依赖：`@zterm/runtime-contracts`、`@zterm/desktop-gateway`、`@zterm/shared`（仅 `./terminal/tmux-socket-path` 子路径）。给主进程新增 shared 子路径导入时，先把该子路径加入 `packages/shared/tsconfig.build.json` 的 `include`，再在 `mac/src/lib/mac-main-shared-contract.test.ts` 的 gate 下验证。禁止主进程导入无 dist 条件的 shared 子路径。

## 验收与反馈

Mac 专属 smoke 和安全操作见 `.agents/skills/zterm-mac-dev/SKILL.md`。用户主路径需对应真实客户端证据；只通过编译不能宣称 app 可用。文档修订不构建或重启 app。

正文说明可用结果、使用入口和未验证范围；测试命令、截图和资源采样留在已有证据目录，不强制五项或六段汇报模板。
