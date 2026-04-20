# Decision 0001: Cross-platform layout profile and shared panes

## 索引概要
- L1-L8 `goal`：统一跨尺寸布局的唯一设计真源。
- L10-L21 `decision`：一套 layout profile 驱动 phone / tablet / foldable / split-screen / Mac。
- L23-L35 `profiles`：布局档位与表现方式。
- L37-L51 `ownership`：app-layer 与平台壳边界。
- L53-L65 `anti-patterns`：禁止的分叉方式。
- L67-L76 `verification`：后续实现必须覆盖的验证口径。

## 目标

把 phone / tablet / foldable / split-screen / Mac 的界面编排统一到**一套 layout profile 决策**里，
保证不同尺寸看到的是同一套 `Connections / Connection Properties / Terminal` 信息结构。

补充冻结：

- 大屏默认采用**一行多列**编排
- pane 之间用**垂直分屏**分隔
- 不把“上下堆叠多个 pane”作为统一主方案

## 决策

1. **只允许一个 layout resolver**
   - 统一由 `resolveLayoutProfile(containerRect, capabilities)` 一类入口输出布局档位。
   - page component 不得各自写 breakpoint 真源。

2. **可复用单元是 phone-sized pane**
   - 大屏不是重画“桌面版页面”，而是在**同一行里编排多个 phone-sized view / pane**。
   - 同一 pane 内继续使用同一套页面组件、字号 token、safe-area token、终端密度规则。

3. **变化只发生在编排层，不发生在页面语义层**
   - `Connections / Connection Properties / Terminal` 的信息结构、交互语义、会话真源保持一致。
   - foldable / pad / Mac 只改变列数、列宽、密度和默认打开策略。

4. **大屏统一策略是一行多列 + 垂直分屏**
   - foldable / pad / split-screen / future Mac 默认先尝试单行双列 / 三列。
   - 只有容器宽度不足以维持 phone-sized pane 时，才回退到更少列数；默认不走上下堆叠主布局。

5. **future Mac 复用 app-layer**
   - Mac 版本复用 shared app-layer 的 page / component / session / storage / layout policy。
   - 平台差异只留在 shell：窗口、菜单、快捷键、拖拽、原生输入、通知。

## Layout profiles

- `phone-single`
  - 单 pane，默认手机竖屏。

- `wide-2col`
  - 单行双列，两个 pane 并排，中间垂直分屏。
  - 适用于 foldable / pad / 中等桌面窗口。

- `wide-3col`
  - 单行三列，三个 pane 并排，中间垂直分屏。
  - 适用于大 pad / future Mac / 足够宽的桌面窗口。

- `compact-fallback`
  - 当 split-screen 或小窗过窄时回退到单列或更少列数。
  - 这是容量回退，不是主视觉方案。

规则：

- profile 由**容器几何 + 平台能力**决定，不由页面自己猜。
- 大屏优先保证“单行多列”成立，再按列数回退。
- 同一 profile 里的 pane 宽度优先保持 phone-sized 上限，避免大屏把单个终端拉到失真。

## Ownership

- `src/lib/layout-profile.ts`
  - 统一根据 container / window / capabilities 输出 layout profile。

- `src/components/layout/PaneFrame.tsx`
  - 单个 phone-sized pane 的统一外框、safe-area、padding、density token。

- `src/components/layout/PaneStage.tsx`
  - 负责 1 / 2 / 3 列编排与垂直分屏，不承载业务真相。

- `src/pages/*`
  - 只消费 profile / pane slot，不自行决定平台分叉。

- Android Shell
  - IME、safe-area、后台服务、通知、权限、Capacitor plugin。

- future Mac Shell
  - 窗口尺寸、菜单/快捷键、拖拽、桌面级原生能力。

## Anti-patterns

- 在 `ConnectionsPage` / `TerminalPage` / `ConnectionPropertiesPage` 内各自写 breakpoint。
- 为 Mac 单独重做一套 desktop-only 信息架构。
- 用 `isAndroid / isMac` 直接切换不同页面语义。
- 把“多 pane 编排”和“多 session 业务语义”混成一个状态机。
- 把“上下堆叠多 pane”继续当成大屏统一主方案。
- 为追求大屏填满而放弃 phone-sized pane 宽度边界。

## Verification

后续实现至少覆盖：

1. phone 单 pane
2. foldable / pad 单行双列
3. 大屏单行三列
4. split-screen 窄窗回退
5. future Mac 可变窗口

验收口径：

- 同一连接 / session / terminal 语义在不同 profile 下保持一致
- 只变编排，不变真源
- 没有 page-local breakpoint 成为第二真源
