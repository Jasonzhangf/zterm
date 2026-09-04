# Remote Window Aspect & Transport Decoupling (2026-09-04)

## Goal

Remote window 三个独立但相关的事实：

1. **Container aspect** — Android 端视频容器（preview drawer 或 fullscreen 投影）的长宽比，由用户当前的方向选择决定。
2. **Remote target size** — macOS 端目标应用窗口（可 resize 的 AppWindow）应当缩放到何种尺寸；不可 resize 的目标（如 iTerm2 shell、终端式进程）保持原尺寸。
3. **Stream quality** — 推流码率 / 帧率上限，独立于容器与目标尺寸。

三者解耦后，再定义一致的优先级规则，确保：

- 不裁切源画面：本地只做 letterbox（contain），永远不 cover/clip。
- 容器按“面积最大化”显示：当 AppWindow 可 resize 时，本地要求 daemon 把 AppWindow resize 到与容器一致的长宽比，streamer 按需求档位（720 / 1080 / 2160 short-edge）出流；本地直接 1:1 渲染，无需 letterbox。
- AppWindow 不可 resize（`inputRoute = tmux-input` 或 `focusPolicy != bring-to-focus`）或用户显式锁定原始比例时：本地按容器 aspect 做 letterbox，源画面不被裁切。

## Owners / Allowed Paths

### `RemoteWindowDisplayOrientation` owner（新增）

- 唯一持有 `displayOrientation: 'portrait' | 'landscape' | 'follow-device'`，由 RemoteWindowOverlayController 内部 React state + `writeRemoteWindowDisplayOrientation` 持久化键保存。
- 读取入口：`RemoteWindowOverlayController` 根据设备和 visual viewport 计算 container aspect。
- 写入入口：仅 `RemoteWindowMorePanel` 中方向控件。
- Forbidden：任何其他 owner 修改 orientation state；不能将 orientation 写入 daemon mirror 或 remote target payload。

### `RemoteWindowResizeViewport` owner（RemoteWindowOverlayController 内部）

- 唯一将 container aspect + 当前 quality tier（`smooth-720` / `quality-1080` / `ultra-2160`）计算为 `RemoteWindowTargetResize` 事件并通过 `resizeTargetWindow` 发送给 daemon。
- 若目标标记为不可 resize，则跳过 resize 请求，保留原始 size。
- Forbidden：把 orientation / quality tier / multiplier 落到 `resizeTargetWindow` 之外的通道。

### `RemoteWindowQualityControls` owner（新增）

- 唯一暴露 `bitrateMultiplier: 1 | 2 | 4` 与 `maxFrameRateFps: 15 | 30 | 60` 控件，绑定到 RemoteWindowMorePanel。
- 乘以 quality tier base bitrate 决定推流上限；FPS 通过 quality request 通道传输。
- Forbidden：把 multiplier / maxFrameRate 写入 content payload；只能走 quality request 通道。

### `RemoteWindowLocalLetterbox` owner（RemoteWindowOverlayController 内部）

- 本地显示只按 `(containerSize, sourceSize)` 计算 contain rect，不裁切 source。
- `object-fit` 永远使用 `contain`；不允许 `cover`。

## Pipeline

1. 方向解析 → container aspect。
2. 可 resize AppWindow 使用 container aspect 请求 resize。
3. daemon 反馈 source frame size。
4. 本地使用 contain/letterbox 渲染。
5. 质量控制独立维护 bitrate / FPS。

## Acceptance

- orientation、resize、non-resizable、contain 和 quality controls 有定向测试。
- emulator-5554 验证 preview/fullscreen 方向切换和质量控件。

## Forbidden

- 引入 `cover` / 裁切。
- 修改 daemon capture 路径或 stream plan。
- 把 container / orientation / quality 写到 mirror / sparse buffer / capture metadata。
