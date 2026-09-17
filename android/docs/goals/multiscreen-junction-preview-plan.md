# 多屏预览 · 交界取景方案设计

状态：**已实施，待独立 review / 交付收口**。本文件记录已审批的方案、生命周期和当前实现绑定；实现与证据状态以本文件末节为准。

设计稿（本地 evidence，未入库）：
`android/evidence/2026-09-16-multiscreen-preview/junction-crop-v3.html`

---

## 1. 目标与非目标

### 目标

- 多屏预览收敛为**唯一一种形态**：全尺寸窗格组成虚拟网格，手机屏幕是取景框，取景位置落在网格交界处。
- 生命周期闭环：从进入、运行、集合变更到退出，每条路径都有唯一 owner、明确前后置条件和可验收结果。
- 预览不切 active session、不改 tmux geometry、不重连 transport、不重置 buffer；QuickBar 输入只允许路由到当前焦点格，不得改 active session / geometry / transport / buffer。

### 非目标

- 不保留旧的主次 3:1 布局、左中右三列、group 形态。
- 不做缩略图（任何 `scale` / `transform: scale` 都被禁止）。
- 不新增第二套 ANSI / cell / cursor 解析器。
- 不改 daemon mirror、sparse buffer、transport、tmux 宽度语义。
- 本次不发布 OTA，不把构建分配号写入功能提交；需要设备包时由 `scripts/bump-build-version.mjs` 在工作树本地分配。

---

## 2. 唯一方案定义

废弃：`WindowGroupLayout` 的 `primary + secondary` 3:1 预览布局，以及“左上中右上中下右下”九宫格 group。

### 2.0 窗口模型（审批修正 v2）

**语义：取景框在虚拟网格上平移，不是交换 session。**

- 窗格全尺寸铺在一个虚拟网格（lattice）上，每个格位可选地持有一个 session。
- 手机屏幕是取景框：焦点格完整可见，相邻格只露被屏幕边缘切出来的一条。
- 点击边缘槽位 = 取景框平移一格，让那一格成为焦点。**不是互换 session。**
- 平移后，刚才的焦点格留在原坐标，变成反方向边缘上的那条槽位。
- 点击空格的“+”= 给该格指定 session 并持久化。
- 长按边缘槽位 = 重新指定或清空该格。
- 抽屉选择 = 给**当前焦点格**换 session；网格其它格不动。

坐标只描述“取景框看哪里”，不搬运 session：

```text
          col -1           col 0
        ┌─────────┐      ┌─────────┐
        │    A    │      │    B    │     A、B 固定在各自格位
        └─────────┘      └─────────┘
                                 ▲
                              焦点 col 0
        ┌───────────────────────────────┐
        │ A 右边缘 38px │      B 完整     │   ← 取景框：单侧在左
        └───────────────────────────────┘

  点击左侧槽位 A → 取景框平移一格，焦点变 col -1：

        ┌───────────────────────────────┐
        │     A 完整     │ B 左边缘 38px │   ← 取景框：单侧在右
        └───────────────────────────────┘
```

这就是“手机窄屏只有单侧有，点击过去以后变成另一侧有”。

### 2.1 可见槽位数量由设备方向与宽度决定

| 形态 | 中心 | 边缘槽位 | 同屏窗口 |
| --- | --- | --- | --- |
| 手机竖屏（窄） | 1 格完整 | 水平单侧 1 + 上 1 + 下 1 | 4 |
| 手机横屏 | 2 格并排（2 分屏） | 上 1 + 下 1 | 4 |
| 平板 / 宽屏（宽高比 ≥ 16:9） | 1 格完整 | 左 1 + 右 1 + 上 1 + 下 1 | **5** |

规则：

- 窄屏横向放不下两侧，只露**单侧**一条；焦点平移后那条自动换到另一侧。
- 横屏时轴向换过来：原来的左右关系变成中间 2 分屏，上下两条保留。
- 平板足够宽，左右上下四条同时可见，**第 5 个窗口给**（焦点 + 左右上下）。
- 第五窗口不是额外数据模型：它就是左右两条同时进入视野，格子真源不变。

### 2.2 取景框与格子坐标

保留唯一形态：

```text
                  ┌───────────────────────┐
   上槽位可见条   │  api-gateway 底边 30px │
                  └───────────────────────┘
  ┌──────┬────────────────────────────────┐
  │ left │                                │
  │ 38px │        center 全尺寸窗格        │
  │ 可见 │        完整可见                 │
  └──────┴────────────────────────────────┘
                  ┌───────────────────────┐
   下槽位可见条   │    tests 顶边 30px     │
                  └───────────────────────┘
```

- 左槽位：固定一个 session，只露右边缘窄条。
- 中心：当前 active session，完整可见。
- 上槽位：可见的是该 session 的底边窄条。
- 下槽位：可见的是该 session 的顶边窄条。
- 所有窗格按原生字号、原生行高全尺寸渲染；邻居是被屏幕边缘裁切，不是缩小。

### 2.3 格子与 session 的持久化

```ts
interface JunctionPreviewLatticeV1 {
  version: 1;
  cells: Array<{
    col: number;
    row: number;
    target: SessionPreviewTarget;
  }>;
}
```

- 存储 key：`zterm:junction-preview-lattice:v1`（独立于 active session，独立于旧 preview selection）。
- 格子坐标是持久真源；**焦点坐标是预览内状态**，不写进这份真源。
- 写入时机：给空格指定 session、长按重选、长按清空、抽屉给焦点格换 session。
- 解析时机：每次渲染时用当前打开集合解析；解析不到的格子视为空，显示“+”，不自动新开 session。
- 旧 `zterm:session-preview-selection:v1` 的迁移：**不迁移**。它的语义（最多 6 个有序选择）与新模型不同，强行映射会造出假状态；旧 key 作为死数据保留，不做静默转换。

#### 上下槽位跟随焦点列（已定）

上下槽位是**焦点格所在列的上下格**。所以取景框横向平移时，上下槽位也跟着换列：

```text
焦点在 col 1：        焦点在 col 0（点击左侧格之后）：
  up   = (1, -1)        up   = (0, -1)
  focus= (1,  0)        focus= (0,  0)
  down = (1, +1)        down = (0, +1)
```

- 这是“格子坐标”模型的必然结果：每列各有自己的上下格。
- 含义：横向平移后，上下两条会显示**新列**的上下格；如果那一列没设过，就是“+”。
- 备选（已否决）：上下槽位绑定“焦点 session 自身”，横向平移时不变。那样上下槽位就不是格子坐标，而是 session 的附属属性，模型会分裂成两套坐标语义。

采用格子坐标语义：单一模型，无特例。

---

## 3. 生命周期状态机

### 3.1 状态

只保留两个状态，不引入 `opening / closing`：

```text
closed  ──enter──▶  open
   ▲                  │
   └──────exit────────┘
```

理由（消融）：当前没有需要中间态的入场/退场动画；动画若要加，也应该在 `open` 内用 CSS 过渡表达，而不是把中间态提升为 mode owner 的真源。多一个状态就多一份可以不一致的真相。

### 3.2 进入快照

进入时由 mode owner 一次性捕获，退出时原样恢复：

```ts
interface SessionPreviewEntrySnapshot {
  activeSessionId: string | null;
  slotIds: TerminalSessionGroupSlotIds;
  focusSlot: TerminalSessionGroupFocusSlot;
}
```

规则：

- 进入不改 active session、不改 slot、不触发 resize / reconnect / viewport 写入。
- 退出只恢复快照；不做“重新计算一个近似状态”。
- 快照只保存一次；`open` 期间的任何居中切换都不改写快照。

### 3.3 过渡表

| 事件 | 前置条件 | 动作 | 后置条件 |
| --- | --- | --- | --- |
| 进入 | 当前为 `closed` | 捕获快照 → 建立取景框与可见渲染集 → `open` | active session 不变；只读投影就绪 |
| 点击边缘格 | `open` 且该格有 session | 取景框平移一格，焦点坐标更新 | 格子坐标不变；无 session 搬运 |
| 点击空“+” | `open` | 打开选择菜单 → 给该格指定 session 并持久化 | 其余格不动 |
| 长按边缘格 | `open` | 打开重选 / 清空菜单 | 不退出、不移动焦点 |
| 抽屉切焦点格 | `open` 且抽屉选中项仍在打开集合 | 只替换焦点格的 session | 其余格与快照不变 |
| 退出 | `open` | 释放可见渲染集 → 恢复快照 → `closed` | 无重连、无 buffer 重置；格子保留 |

---

## 4. 触发（如何进入）

### 4.1 入口清单

| 编号 | 入口 | 现状 | 方案 |
| --- | --- | --- | --- |
| T1 | 终端舞台右缘向左滑 | 已有 | 保留为唯一预览入口 |
| T2 | 抽屉“多选”模式 → 完成 | 已有 | **物理移除** |
| T3 | 抽屉目录长按 / 目录行 | 已有 | **物理移除**预览语义，恢复为普通展开/菜单 |
| T4 | 顶部“预览”显式按钮 | 无 | **不新增**（边缘已可见，不需要第二个入口） |

T1 参数沿用现有唯一 owner `src/lib/session-preview-gesture.ts`：

- 右缘判定带：`SESSION_PREVIEW_RIGHT_EDGE_PX = 64`
- 横向轴锁：`8px`
- 左滑阈值：`SESSION_PREVIEW_SWIPE_THRESHOLD_PX = 48`
- 垂直、反向、未过阈值、非右缘起手一律不进入，且不得把事件转交给其他 owner。

### 4.2 进入前置条件

| 编号 | 条件 | 不满足时的行为 |
| --- | --- | --- |
| P1 | 当前不在 `open` | 幂等忽略重复进入 |
| P2 | 无 IME 持有屏幕 | 显式提示先收起输入法，或由现有 IME owner 收起后再进入 |
| P3 | 焦点格有可解析的 active session | 无焦点 session 时不进入，显式提示 |
| P4 | 可见渲染集可建立（焦点格 + 可见格） | 显式失败，不静默降级 |

### 4.3 进入动作

```text
enter
  → 校验 P1..P4
  → 捕获 SessionPreviewEntrySnapshot
  → 读取格子真源，按当前方向/宽度解析可见格（stale 格回落成“+”）
  → 焦点坐标初始化为当前 active session 所在格
  → 只为可见且有 session 的格挂载只读 TerminalView
  → sessionPreviewOpen = true
```

进入时必须保持的硬约束：

- 不调用 `onSwitchSession`
- 不调用任何 resize / width-mode / viewport 写入
- 不调用 transport open / reconnect
- 不为空格或 stale 格挂载 renderer

---

## 5. 关闭（如何退出）

### 5.1 出口清单

| 编号 | 出口 | 现状 | 方案 |
| --- | --- | --- | --- |
| E1 | 系统 Back | 已有 | 保留 |
| E2 | 顶部 × 按钮 | 已有 | 保留 |
| E3 | 预览内右滑 ≥ 48px | 已有 | 保留 |
| E4 | 焦点格 session 被关闭且无可移动格 | 部分 | 补齐：无任何有效格则退出 |

所有出口必须调用**同一个** mode owner 退出函数，不允许各自复制恢复逻辑。

### 5.2 退出动作

```text
exit
  → 卸载预览可见渲染集（只卸载，不关 session、不重置 buffer）
  → sessionPreviewOpen = false
  → 恢复 SessionPreviewEntrySnapshot（activeSessionId / slotIds / focusSlot）
  → 格子持久化保留
  → 清空 entry snapshot
```

退出时禁止：

- 不重连、不重新 attach、不重建 transport
- 不重置 sparse buffer / render store
- 不改写 tmux 宽度或 viewport
- 不清空格子（只有长按清空才移除对应格）

### 5.3 哪些交互**不**退出

| 交互 | 结果 |
| --- | --- |
| 点上方窄条 | 取景框上移一格；该格成为焦点，原焦点格成为下方窄条 |
| 点下方窄条 | 取景框下移一格；该格成为焦点，原焦点格成为上方窄条 |
| 点左侧窄条 | 取景框左移一格；该格成为焦点，原焦点格成为右侧窄条 |
| 点空槽位“+” | 打开选择菜单，选中后给该格指定 session |
| 点焦点窗格 | 不退出、不切 session（焦点格由抽屉换 session） |
| 长按边缘窗格 | 打开重选 / 清空菜单 |
| 中心内垂直滚动 | 只滚该窗格本地历史，不退出 |
| 中心内横向拖动 | mirror-fixed 裁切/平移，不退出、不触发 E3 |
| 长按窗格 | 打开替换/移除菜单，不退出 |

E3 与中心横向拖动的冲突按现有规则处理：滚动/平移表面不参与退出右滑判定。

---

## 6. 格子与焦点在 `open` 期间的变化

| 变化 | 方案 |
| --- | --- |
| 焦点格的 session 被关闭 | 焦点移到最近的有 session 的格子；全部为空则退出 |
| 任一非焦点格 session 被关闭 | 该格回落成空，显示“+”；焦点不动 |
| 新 session 打开 | 不自动进格；只有显式“+”选择才写入 |
| 格子出现 stale | 解析失败即视为空格，不自动新开 session |
| 抽屉选中新 session | 只替换焦点格的 session；其余格不动 |

---

## 7. 抽屉在预览中的行为（审批修正）

预览打开时左侧抽屉**仍可划出**：

| 项 | 方案 |
| --- | --- |
| 手势 | 保留左缘向右划打开抽屉 |
| 抽屉选择 | 只给焦点格换 session |
| 其它格子 | 不受抽屉影响，保持不变 |
| 预览状态 | 抽屉打开期间预览保持 `open`，不卸载渲染集 |
| 关闭抽屉 | 回到预览，焦点格已是新 session |

实现要点：

- 现在预览用 `TerminalPreviewGrid` 替换了整个 stage，抽屉手势挂在被替换掉的 `TerminalTabSwipeSurface` 上，所以划不出来。
- 方案：把抽屉入口手势上提到 stage 容器层（与预览入口手势同一层），不依赖被替换的子组件。
- 抽屉渲染层位于 `zIndex 149/150`，预览层是 `zIndex 12`，抽屉本来就在上层，不需要改层级。
- 手势归属：左缘向右 → 抽屉；右缘向左 → 预览入口（仅 `closed` 时）；中心区域 → 预览内滚动/平移。

---

## 8. 后台、前台、IME、旋转

| 场景 | 方案 | 依据 |
| --- | --- | --- |
| 短时切后台再回前台 | 保持 `open`，槽位与可见渲染集不变 | 现有测试 `keeps preview mode and every selected live id stable across a short background round trip` |
| 回到前台 | 不重放进入动作、不重建快照 | 避免二次挂载 |
| 预览中唤起 Quick Bar | 待拍板：沿用现有“输入打到中心 session”，还是预览内禁用输入 | 现有测试把 QuickBar 输入路由到预览 primary |
| 旋转 / 尺寸变化 | 保持 `open` 与格子；只重算几何与可见槽位数量，不重挂 renderer | 几何是纯函数投影 |
| 竖屏 → 横屏 | 中心变 2 分屏；左右槽位收成上下槽位 | 见 §2.1 |
| 手机 → 平板宽度 | 边缘槽位从单侧扩成左右上下四条 | 见 §2.1 |

---

## 9. 几何与可见渲染集

### 9.1 竖屏基准（设计稿实测）

| 参数 | 值 |
| --- | --- |
| 取景框 | `374 × 706` |
| 字符宽 / 行高 / rail 高 | `6.6 / 15 / 19` |
| 列间距 | `6` |
| 左列 | `22` 列 → 全尺寸 `145 × 634`，可见 `38px` |
| 焦点列 | `50` 列 → 全尺寸 `330 × 634`，完整可见 |
| 上 / 下槽位 | `50` 列 × `10` 行 → 全尺寸 `330 × 169`，可见 `30px` |
| 焦点列行数 | `41` 行 |

### 9.2 横屏（手机）

- 焦点区变成 **2 格并排**，各占一半宽度，都完整可见。
- 左右槽位收成上 / 下两条窄带。
- 同屏仍是 4 个窗口：2 分屏 + 上下各 1 条。

### 9.3 平板 / 宽屏

- 宽高比 ≥ 16:9 时，左右上下四条窄带同时可见。
- 同屏窗口数见 §11 待确认项（建议上限 5：焦点 + 左右上下）。

### 9.4 响应式推导

```text
edges = (landscape && phone) ? { top: 1, bottom: 1 }
      : (wide)                ? { left: 1, right: 1, top: 1, bottom: 1 }
      :                         { left: 1, top: 1, bottom: 1 }
centerCols = floor((viewWidth - edgeCols - gaps) / charW)
centerRows = floor((viewHeight - edgeRows - gaps - railH) / rowH)
```

窄屏只减 `centerCols`，不缩字号、不缩放窗格。焦点列低于可读下限时显式提示不支持，不静默缩放。

### 9.5 渲染集预算

- 手机竖屏：4 个（焦点 + 单侧 + 上 + 下）。
- 手机横屏：4 个（2 分屏 + 上 + 下）。
- 平板：5 个（焦点 + 左右上下）。
- 空格与 stale 格**不挂 renderer**，只渲染“+”。
- 取景框平移时，新进入视野的格挂载，移出视野的格卸载。

---

## 10. Owner 与文件映射

| 职责 | 唯一 owner | 本次变化 |
| --- | --- | --- |
| 进入手势判定 | `src/lib/session-preview-gesture.ts` | 不变 |
| preview mode + entry snapshot | `src/pages/TerminalPage.tsx` | 扩展：焦点坐标 + 可见格投影 |
| 格子真源与持久化 | 新增 `src/lib/junction-preview-lattice.ts` | 新增（替代 selection 语义） |
| 旧 selection 代码 | `src/lib/session-preview-selection.ts` | 从预览路径物理移除；如无其他调用者则删除 |
| 取景框几何纯函数 | 新增 `src/lib/junction-preview-layout.ts` | 新增（含方向/宽度分支） |
| 预览渲染 | `src/components/terminal/TerminalPreviewGrid.tsx` | 重写为交界取景 |
| 只读终端投影 | `src/components/TerminalView.tsx` | 复用 `preview-primary`，不新增解析器 |
| 旧主次布局 | `src/components/terminal/WindowGroupLayout.tsx` | 预览不再使用；RemoteWindowOverlay 继续使用，不删 |
| registry / 测试设计 | `feature/resource/module/edge registry`、`docs/testing/terminal-session-preview-test-design.md` | 审批后同步 |

禁止路径不变：`src/server/`、`src/contexts/session-context-transport-runtime.ts`、`src/contexts/session-context-buffer-runtime.ts`。

---

## 11. 待你拍板（阻塞项）

已由本次审批确定，不再列为问题：

- 抽屉不再多选；抽屉选择只给**焦点格**换 session。
- 点击边缘格 = **取景框平移**，焦点换到该格；不做 session 互换。
- 手机竖屏：焦点 1 格 + 单侧 1 条 + 上下 2 条，共 4 个窗口。
- 手机横屏：中间 2 分屏 + 上下 2 条，共 4 个窗口。
- 平板 / 宽屏：左右上下四条同时可见（窗口数见下条）。
- 格子持久化，空格显示“+”；点“+”指定、长按重选或清空。
- 预览中抽屉仍可划出，只改焦点格。

仍需拍板：

已定：

- 平板 / 宽屏给 **5 个窗口**（焦点 + 左右上下）。
- 上下槽位**跟随焦点列**（纯格子坐标语义）。

仍需拍板：

1. **“平板”判定阈值**：建议宽高比 ≥ 16:9 且宽度足够容纳 2 条侧边 + 可读焦点列；具体像素阈值待定（建议实现时用一个具名常量）。
2. **横屏 2 分屏的分配**：建议两格等宽；是否需要一主一次（如 2:1）。
3. **点焦点窗格的行为**：建议不退出、不切 session。
4. **边缘条宽度**：手机左条 `38px`、上下 `30px`；平板左右是否同宽，上下是否同高。
5. **身份标签**：窄条上的 chip 是否保留。
6. **退出后格子**：建议保留；是否需要在退出时清空。
7. **预览中 Quick Bar 输入目标**：沿用现有“打到焦点格”，还是预览内禁用输入。
8. **旧 selection 数据**：建议不迁移、直接废弃旧 key。

---

## 12. 实施任务分拆（基于现有代码）

### 12.1 阶段 A · 真源与纯函数（先红测，无 UI 依赖）

| 任务 | 动作 | 文件 | 交付 iff |
| --- | --- | --- | --- |
| A1 | **新增**格子真源：`JunctionPreviewLatticeV1`、读写、normalize、setCell / clearCell / moveFocus 校验 | `src/lib/junction-preview-lattice.ts` + `.test.ts` | 坐标唯一、stale 解析为空、损坏存储显式失败 |
| A2 | **新增**取景框几何：竖屏 / 横屏 / 平板三形态的可见格、crop 偏移、列数行数推导 | `src/lib/junction-preview-layout.ts` + `.test.ts` | 三形态几何断言全绿；`transform` 只允许 translate |
| A3 | **保留**入口手势判定（不改语义） | `src/lib/session-preview-gesture.ts` | 现有测试不动、全绿 |

### 12.2 阶段 B · 渲染重写

| 任务 | 动作 | 文件 | 交付 iff |
| --- | --- | --- | --- |
| B1 | **重写**为交界取景 + 取景框平移；删 `WindowGroupLayout` 依赖、删主次 tile、删边缘队列 overlay | `src/components/terminal/TerminalPreviewGrid.tsx` | 只渲染可见格；空格画“+”；无 `scale`；平移不搬运 session |
| B2 | **新增**“+”选择菜单与长按重选 / 清空菜单 | 同上（或拆 `TerminalPreviewSlotMenu.tsx`） | 点“+”指定格；长按可重选 / 清空；不退出预览 |
| B3 | **重写**测试：几何、四 / 五窗口、平移、空态、长按、render-truth | `TerminalPreviewGrid.test.tsx`、`TerminalPreviewGrid.render-truth.test.tsx` | 正反例覆盖；DOM 与 render store 快照一致 |
| B4 | **复用不改**只读终端投影 | `src/components/TerminalView.tsx` | `preview-primary` 语义保持；无第二解析器 |

### 12.3 阶段 C · 页面整合

| 任务 | 动作 | 文件 | 交付 iff |
| --- | --- | --- | --- |
| C1 | **替换**selection 状态为格子 + 焦点坐标；进入 / 退出快照恢复不变 | `src/pages/TerminalPage.tsx` | 退出精确恢复进入前投影；格子持久化 |
| C2 | **上提**抽屉入口手势到 stage 容器层；预览打开时抽屉仍可划出，且只改焦点格 | `src/pages/TerminalPageStageShell.tsx` | 预览中左缘右滑能开抽屉；槽位不受影响 |
| C3 | **移除**预览对 `WindowGroupLayout` 的调用 | `src/pages/TerminalPageStageShell.tsx` | 预览路径不再 import `WindowGroupLayout` |
| C4 | **重写**页面级测试：进入 / 退出、抽屉切焦点格、平移、关闭收敛、后台往返 | `src/pages/TerminalPage.session-preview.test.tsx` | 现有 12 条用例按新语义改写并全绿 |

### 12.4 阶段 D · 清理（本次范围内确认后物理删除）

| 任务 | 动作 | 文件 | 判据 |
| --- | --- | --- | --- |
| D1 | **删除**旧 selection 真源（已无调用者后） | `src/lib/session-preview-selection.ts` + `.test.ts` | `rg` 无剩余引用；旧 key 不再读写 |
| D2 | **删除**抽屉多选模式：状态、按钮、checkbox、footer、目录长按预览 | `src/components/terminal/TerminalSessionDrawerContent.tsx` | 抽屉回到单一语义：选中即切焦点格 |
| D3 | **删除**契约中的 preview 多选字段 | `src/lib/plugin-session-drawer/session-drawer-contract.ts` | 契约与实现一致；`TerminalSessionDrawer.test.tsx` 全绿 |
| D4 | **删除**抽屉多选相关 props 与 handler | `src/pages/TerminalPage.tsx` | `onPreviewSelectionModeChange` / `onTogglePreviewSession` / `onClearPreviewSelection` / `onPreviewFolder` 全部消失 |
| D5 | **保留**`WindowGroupLayout`（`RemoteWindowOverlayController` 仍在用），只移除预览路径依赖 | `src/components/terminal/WindowGroupLayout.tsx` | 预览不 import；RemoteWindow 测试全绿 |
| D6 | **保留**`TerminalPreviewRow`（`TerminalView` 的 secondary 行投影仍在用），只移除预览 tile 的引用 | `src/components/terminal/TerminalPreviewRow.tsx` | `TerminalView` 相关测试全绿 |

### 12.5 阶段 E · 治理与门禁

| 任务 | 动作 | 文件 | 交付 iff |
| --- | --- | --- | --- |
| E1 | **更新** feature registry：标题、owners、allowed_paths、required_gates | `docs/feature-registry.json` | truth 测试全绿 |
| E2 | **更新** resource registry：`session_preview_selection` → 格子真源；`session_preview_mode` 语义更新 | `docs/resource-registry.json` | truth 测试全绿 |
| E3 | **更新** module registry：owner 职责、public interfaces、owned paths | `docs/module-registry.json` | truth 测试全绿 |
| E4 | **更新** edge registry：删 selection 边，加取景框平移 / 槽位边 | `docs/edge-registry.json` | truth 测试全绿 |
| E5 | **更新**function-map / wiki mainline：删旧 selection 符号，加新符号 | `docs/function-map.md`、`docs/wiki/mainline-*.json|md` | function-wiki truth 全绿 |
| E6 | **更新**测试设计文档 | `docs/testing/terminal-session-preview-test-design.md` | 与新测试一致 |
| E7 | **更新**项目 `AGENTS.md` 预览契约段（若存在旧描述） | `AGENTS.md` | 无与新模型冲突的表述 |

### 12.6 阶段 F · 端到端验证

| 任务 | 动作 | 证据 |
| --- | --- | --- |
| F1 | 定向测试 + type-check + registry/import gates | 命令输出 + exit code |
| F2 | Vite build | build 产物 + exit code |
| F3 | emulator：竖屏三形态、平移、空态“+”、长按、抽屉切焦点格 | 截图 + logcat |
| F4 | emulator：横屏 2 分屏、平板 5 窗口（可用尺寸覆盖或真实设备） | 截图 + 实测几何 |
| F5 | 独立 review（AGY / Codex Review） | review 记录；PASS 后才进入交付讨论 |

### 12.7 并行与互斥

- A1 / A2 可并行（不同文件，无共享写入）。
- B1 依赖 A1 + A2；B2 依赖 B1 的组件骨架。
- C1 依赖 B1 的 props 契约冻结；C2 / C3 依赖 C1。
- D1 依赖 C1 + D4 完成（先摘引用再删文件）。
- E1–E7 依赖 A/B/C 的文件清单冻结；可在实现完成后一次收口。
- F 串行，且必须在 D 完成后执行。

### 12.8 每个任务的测试条件

- A1：`pnpm exec vitest run src/lib/junction-preview-lattice.test.ts`
- A2：`pnpm exec vitest run src/lib/junction-preview-layout.test.ts`
- A3：`pnpm exec vitest run src/lib/session-preview-gesture.test.ts`
- B3：`pnpm exec vitest run src/components/terminal/TerminalPreviewGrid.test.tsx src/components/terminal/TerminalPreviewGrid.render-truth.test.tsx`
- C4：`pnpm exec vitest run src/pages/TerminalPage.session-preview.test.tsx`
- D2 / D3：`pnpm exec vitest run src/components/terminal/TerminalSessionDrawer.test.tsx`
- E1–E5：`pnpm run test:feature-registry`
- F1：`pnpm run type-check` + `pnpm run test:feature-registry`
- F2：`pnpm run build`
- F3：`pnpm run terminal:preview:source-dom-gate`

实际脚本（已核对 `android/package.json`，工作目录 `android/`）：

- 定向：`pnpm exec vitest run <test-file>`
- 全量测试：`pnpm test`
- type-check：`pnpm run type-check`
- build：`pnpm run build`（内部先跑 type-check 再 vite build）
- 架构/registry 门禁：`pnpm run test:feature-registry`
- 预览 source→DOM 门禁：`pnpm run terminal:preview:source-dom-gate`

## 13. 设备证据状态

- 2026-09-17 emulator-5554（2560x1600，density 320）已取得：
  - 横屏手机预览：`android/evidence/session-preview/2026-09-17/junction-device/01-landscape-preview.png`
  - 竖屏手机预览：`02-portrait-before-pan.png`
  - 竖屏空格 “+” 菜单：`03-portrait-empty-plus-menu.png`
  - 预览中左缘右滑抽屉：`04-portrait-drawer-over-preview.png`
  - 抽屉选择后焦点格重定向：`05-portrait-focus-retargeted.png`
- 本轮后续 emulator 被 `com.agentbrowser.app` 抢占前台，`adb shell input swipe` 与 CDP `Input.dispatchTouchEvent` 均无法稳定触发 WebView 的 React touch capture；该环境限制不作为产品通过证据，也不替代自动化覆盖。已复现 6 次，未发现新的产品失败证据。
- 2026-09-17 emulator-5556（`2560x1440` 临时尺寸覆盖、density 240、landscape）已取得宽屏五窗真实设备证据：
  - 五窗均绑定真实 session：焦点 `code-1`，左 `AgentBrowser-2`，右 `AgentTeams-1`，上 `appsdk-3`，下 `AgentBrowser-1`。
  - 截图：`android/evidence/session-preview/2026-09-17/tablet-wide-3011/01-wide-five-session-preview.png`
  - DOM 几何：`android/evidence/session-preview/2026-09-17/tablet-wide-3011/dom-geometry.json`
  - 同期设备信息与日志：`wm-size.txt`、`wm-density.txt`、`rotation.txt`、`package.txt`、`logcat-preview.log`
  - 实测 viewport `1707x960`（比例 `1.778`），预览内容区 `1698.67x724.33`；`layoutForm=wide`，左右边缘 `38px`、上下边缘 `30px`，焦点窗 `1610.67x616.33`，底边缘格 `top=781px`，仍在内容区内。

---

## 13. Goal 提示词

```text
/goal
目标：把 zterm Android 多屏预览收敛为唯一形态——全尺寸窗格组成格子，手机屏幕是取景框，点击边缘格 = 取景框平移一格。
范围与约束：允许改 android/src/lib/junction-preview-*.ts、TerminalPreviewGrid.tsx、TerminalPage.tsx、TerminalPageStageShell.tsx、TerminalSessionDrawerContent.tsx、session-drawer-contract.ts、对应测试与 registry/wiki 文档；禁止改 src/server/、session-context-transport-runtime.ts、session-context-buffer-runtime.ts；禁止 scale、第二解析器、transport/resize/buffer 副作用。
依据：android/docs/goals/multiscreen-junction-preview-plan.md
验收：竖屏 4 窗口 / 横屏 2 分屏 + 上下 / 平板 5 窗口三形态几何测试全绿；点击边缘平移不搬运 session；抽屉不再多选且只改焦点格；预览中抽屉可划出；旧 selection 代码与抽屉多选物理删除；定向测试 + typecheck + registry gates + build 全绿；emulator 截图与 logcat 证据齐全；独立 review PASS。
直接执行本任务，不再为它生成一层提示词。
```

## 14. 当前实现与证据状态

实现已落入当前 worktree：

- 格子真源：`android/src/lib/junction-preview-lattice.ts`
- 取景几何：`android/src/lib/junction-preview-layout.ts`
- 预览渲染：`android/src/components/terminal/TerminalPreviewGrid.tsx`
- 页面整合：`android/src/pages/TerminalPage.tsx`、`android/src/pages/TerminalPageStageShell.tsx`
- 旧 selection 真源已删除，抽屉多选契约已移除

已验证：

- 定向 Vitest：7 files / 80 tests PASS
- `pnpm run type-check` PASS
- `pnpm run test:feature-registry`：13 files / 104 tests PASS
- `pnpm run terminal:preview:source-dom-gate` PASS；证据：
  `android/evidence/session-preview/2026-09-17/source-dom-gate.json`
- Android APK `0.1.3.3011`（`versionCode=1100030110`，SHA-256 `fc2d69211cda2b28ee47ac58eec6b037733b03eb9f53ccb8308c81326d6446b7`）已覆盖安装并加载本 worktree 的 Vite 产物；安装保留 `firstInstallTime=2026-08-30 04:15:27`；宽屏五窗与竖屏交互证据见：
  `android/evidence/session-preview/2026-09-17/tablet-wide-3011/`、`android/evidence/session-preview/2026-09-17/junction-device/`
- 旧 `device-final/` 包记录为 `0.1.3.3006`，只能作为历史交互证据，不作为本次候选的版本绑定证据。

仍未验证：

- 独立 review PASS
- 无
- commit / main 合并 / push 远端验证

### DoD

- 多屏预览只剩交界取景一种形态；点击边缘是取景框平移，不是 session 互换。
- 竖屏 / 横屏 / 平板三形态由同一几何纯函数推导，槽位数量随宽度变化。
- 旧 group 形态与抽屉多选在预览路径上物理移除。
- 所有入口与出口走同一 mode owner，退出精确恢复进入前投影。
- 无缩放、无第二解析器、无 transport / resize / buffer 副作用。
- 格子持久化，空格显示“+”；同屏渲染集不超过形态上限。
- 定向测试、gates、build、emulator 证据齐全；未验证项显式列出。
