export const ITERM2_CATALOG_PYTHON = String.raw`
import json
import iterm2

def frame_dict(frame):
    return {
        "x": int(round(frame.origin.x)),
        "y": int(round(frame.origin.y)),
        "width": int(round(frame.size.width)),
        "height": int(round(frame.size.height)),
    }

async def node_dict(node):
    if hasattr(node, "session_id"):
        tty = None
        try:
            tty = await node.async_get_variable("session.tty")
        except Exception:
            tty = None
        grid = None
        try:
            grid = {"width": int(node.grid_size.width), "height": int(node.grid_size.height)}
        except Exception:
            grid = None
        return {
            "type": "session",
            "sessionId": node.session_id,
            "title": getattr(node, "name", "") or "",
            "tty": tty,
            "frame": frame_dict(node.frame),
            "gridSize": grid,
        }
    children = []
    for child in getattr(node, "children", []) or []:
        children.append(await node_dict(child))
    return {
        "type": "splitter",
        "vertical": bool(getattr(node, "vertical", False)),
        "children": children,
    }

async def main(connection):
    app = await iterm2.async_get_app(connection)
    windows = []
    for window in app.terminal_windows:
        frame = await window.async_get_frame()
        tabs = []
        for tab in window.tabs:
            # 只读布局信息；不调用 async_update_layout()（会强制重排 pane，干扰用户正在使用的 iTerm2）
            root = await node_dict(tab.root) if tab.root else None
            tabs.append({
                "tabId": tab.tab_id,
                "activeSessionId": tab.active_session_id,
                "root": root,
            })
        windows.append({
            "windowId": getattr(window, "window_id", "") or "",
            "title": "iTerm2",
            "pid": 0,
            "frame": frame_dict(frame),
            "tabs": tabs,
        })
    print(json.dumps({"windows": windows}, ensure_ascii=False))

iterm2.run_until_complete(main)
`;
