import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";

import {
  buildTerminalMuxCapabilities,
  buildTerminalMuxReady,
} from "../../../../packages/shared/src/connection/protocol.ts";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

const TMUX_STABLE_PREFIX = "tmux:v1:";
const DEFAULT_COLOR = 256;
const CAPTURE_INTERVAL_MS = 180;

function runTmux(socket, args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeCell(char, width = 1) {
  return { char, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 0, width };
}

function isWide(codePoint) {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff);
}

function textToCells(text) {
  const cells = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 32;
    const wide = isWide(codePoint);
    cells.push(makeCell(codePoint, wide ? 2 : 1));
    if (wide) {
      cells.push(makeCell(32, 0));
    }
  }
  return cells;
}

function stableIdFor({ socket, serverPid, sessionId, createdAt }) {
  return `${TMUX_STABLE_PREFIX}${encodeURIComponent(JSON.stringify({
    backend: "tmux",
    socketPath: socket,
    serverPid,
    sessionId,
    createdAt,
  }))}`;
}

/**
 * Protocol-faithful V1 terminal WS/mux fixture used ONLY by tests when the real
 * V1 daemon cannot run. It implements the public `mux-hello` / `mux-ready` /
 * `mux-target-message` / `mux-channel-*` contract and drives a real tmux server
 * on the provided dedicated socket. It is not product code and owns no V2
 * terminal truth.
 */
export function createV1MuxFixture({
  tmuxSocket,
  authToken = "",
  daemonHostId = "",
  host = "127.0.0.1",
  log = () => {},
  chunkSize = 0,
  autoCapture = true,
  openDelayMs = 0,
  openDelaySessionName = "",
} = {}) {
  const channels = new Map();
  const recorded = {
    frames: [],
    bufferSync: [],
    bufferSyncRequests: [],
    input: [],
    channelOpen: [],
    channelClose: [],
  };
  const wss = new WebSocketServer({ noServer: true });
  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  function listCatalog() {
    let stdout;
    try {
      stdout = runTmux(tmuxSocket, [
        "list-sessions", "-F",
        "#{session_name}|#{session_id}|#{session_created}|#{window_width}|#{window_height}|#{pid}",
      ]);
    } catch {
      return { sessions: [], sessionCatalog: [] };
    }
    const sessionCatalog = stdout.split("\n").filter(Boolean).map((line) => {
      const [name, sessionId, createdRaw, widthRaw, heightRaw, pid] = line.split("|");
      const createdAt = Number.parseInt(createdRaw ?? "", 10);
      const columns = Number.parseInt(widthRaw ?? "", 10);
      const rows = Number.parseInt(heightRaw ?? "", 10);
      return {
        name,
        backend: "tmux",
        stableId: stableIdFor({ socket: tmuxSocket, serverPid: pid, sessionId, createdAt: Number.isFinite(createdAt) ? createdAt : 0 }),
        columns,
        rows,
      };
    }).filter((entry) => entry.name);
    return { sessions: sessionCatalog.map((entry) => entry.name), sessionCatalog };
  }

  function capturePane(sessionName) {
    const dims = runTmux(tmuxSocket, ["display-message", "-p", "-t", sessionName, "#{window_width} #{window_height}"]).trim();
    const [colsRaw, rowsRaw] = dims.split(" ");
    const cols = Number.parseInt(colsRaw ?? "", 10) || 80;
    const rows = Number.parseInt(rowsRaw ?? "", 10) || 24;
    let text = "";
    try {
      text = runTmux(tmuxSocket, ["capture-pane", "-p", "-t", sessionName]);
    } catch {
      text = "";
    }
    const lines = text.replace(/\n$/, "").split("\n");
    while (lines.length < rows) {
      lines.push("");
    }
    return { cols, rows, lines: lines.slice(-rows) };
  }

  function send(ws, frame) {
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  function sendChannelMessage(ws, channelId, message) {
    send(ws, { type: "mux-channel-message", payload: { channelId, message } });
  }

  function stopChannel(channelId, reason) {
    const channel = channels.get(channelId);
    if (!channel) {
      return;
    }
    channels.delete(channelId);
    if (channel.timer) {
      clearInterval(channel.timer);
    }
    if (channel.openTimer) {
      clearTimeout(channel.openTimer);
    }
    recorded.channelClose.push({ channelId, reason, at: Date.now() });
    log({ event: "fixture.channel.close", channelId, reason });
  }

  function publish(channel, capture) {
    channel.revision += 1;
    const generatedAt = Date.now();
    const revision = channel.revision;
    const { cols, rows } = capture;
    const indexed = capture.lines.map((text, index) => ({ index, cells: textToCells(text) }));
    sendChannelMessage(channel.ws, channel.id, {
      type: "buffer-head",
      payload: {
        sessionId: channel.stableId,
        revision,
        latestEndIndex: rows,
        availableStartIndex: 0,
        availableEndIndex: rows,
        cursorKeysApp: false,
        cursor: { rowIndex: Math.max(0, rows - 1), col: 0, visible: true },
      },
    });
    const effectiveChunk = chunkSize > 0 && chunkSize < rows ? chunkSize : rows;
    const chunkCount = Math.ceil(rows / effectiveChunk);
    for (let index = 0; index < chunkCount; index += 1) {
      const startIndex = index * effectiveChunk;
      const endIndex = Math.min(rows, startIndex + effectiveChunk);
      const payload = {
        revision,
        startIndex,
        endIndex,
        frameStartIndex: 0,
        frameEndIndex: rows,
        frameChunkIndex: index,
        frameChunkCount: chunkCount,
        generatedAt,
        cols,
        rows,
        cursorKeysApp: false,
        cursor: { rowIndex: Math.max(0, rows - 1), col: 0, visible: true },
        lines: indexed.slice(startIndex, endIndex),
      };
      sendChannelMessage(channel.ws, channel.id, { type: "buffer-sync", payload });
      recorded.bufferSync.push({ channelId: channel.id, payload });
    }
  }

  function tick(channel) {
    let capture;
    try {
      capture = capturePane(channel.sessionName);
    } catch (error) {
      log({ event: "fixture.capture.error", message: String(error && error.message ? error.message : error) });
      return;
    }
    const signature = `${capture.cols}x${capture.rows}:${capture.lines.join("\n")}`;
    if (signature === channel.lastSignature) {
      return;
    }
    channel.lastSignature = signature;
    publish(channel, capture);
  }

  function openChannel(ws, payload) {
    const catalog = listCatalog();
    const entry = catalog.sessionCatalog.find((candidate) => candidate.name === payload.sessionName);
    recorded.channelOpen.push({ payload, found: Boolean(entry), at: Date.now() });
    if (!entry) {
      send(ws, {
        type: "mux-channel-closed",
        payload: {
          channelId: payload.channelId,
          reason: `session ${payload.sessionName} was not found`,
          code: "session_not_found",
        },
      });
      return;
    }
    const channel = {
      id: payload.channelId,
      ws,
      sessionName: entry.name,
      stableId: entry.stableId,
      revision: 0,
      lastSignature: "",
      timer: null,
      openTimer: null,
    };
    channels.set(channel.id, channel);
    const announce = () => {
      if (!channels.has(channel.id) || channel.ws !== ws) {
        return;
      }
      channel.openTimer = null;
      send(ws, {
        type: "mux-channel-opened",
        payload: {
          channelId: channel.id,
          sessionName: channel.sessionName,
          stableId: channel.stableId,
          capabilities: { reliableInput: { version: 1 } },
        },
      });
      if (autoCapture) {
        channel.timer = setInterval(() => tick(channel), CAPTURE_INTERVAL_MS);
        channel.timer.unref?.();
        tick(channel);
      }
    };
    if (openDelayMs > 0 && entry.name === openDelaySessionName) {
      channel.openTimer = setTimeout(announce, openDelayMs);
      channel.openTimer.unref?.();
    } else {
      announce();
    }
  }

  function handleInput(channel, data) {
    const text = String(data ?? "");
    recorded.input.push({ channelId: channel.id, data: text, at: Date.now() });
    const body = text.replace(/\r$/, "").replace(/\n$/, "");
    if (body) {
      runTmux(tmuxSocket, ["send-keys", "-t", channel.sessionName, "-l", body]);
    }
    if (text.endsWith("\r") || text.endsWith("\n")) {
      runTmux(tmuxSocket, ["send-keys", "-t", channel.sessionName, "Enter"]);
    }
  }

  function handleFrame(ws, frame) {
    recorded.frames.push({ kind: "in", frame });
    switch (frame.type) {
      case "mux-hello":
        send(ws, buildTerminalMuxReady({
          ...(daemonHostId ? { daemonHostId } : {}),
          capabilities: buildTerminalMuxCapabilities({ reliableInput: { version: 1 } }),
        }));
        return;
      case "mux-target-message": {
        const message = frame.payload && frame.payload.message;
        const requestId = frame.payload && frame.payload.requestId;
        if (message && message.type === "list-sessions") {
          const catalog = listCatalog();
          send(ws, {
            type: "mux-target-message",
            payload: {
              ...(requestId ? { requestId } : {}),
              message: { type: "sessions", payload: { sessions: catalog.sessions, sessionCatalog: catalog.sessionCatalog.map(({ columns, rows, ...entry }) => entry) } },
            },
          });
          return;
        }
        send(ws, {
          type: "mux-target-message",
          payload: {
            ...(requestId ? { requestId } : {}),
            message: { type: "error", payload: { code: "unsupported_target_message", message: `Unsupported target message ${message && message.type}` } },
          },
        });
        return;
      }
      case "mux-channel-open":
        openChannel(ws, frame.payload);
        return;
      case "mux-channel-message": {
        const channelId = frame.payload && frame.payload.channelId;
        const channel = channels.get(channelId);
        const message = frame.payload && frame.payload.message;
        if (!channel) {
          send(ws, { type: "mux-error", payload: { code: "mux_unknown_channel", message: "channel is not open", channelId } });
          return;
        }
        if (message && message.type === "input") {
          handleInput(channel, message.payload);
        }
        if (message && message.type === "buffer-sync-request") {
          recorded.bufferSyncRequests.push({
            channelId,
            message,
            at: Date.now(),
          });
        }
        return;
      }
      case "mux-channel-binary": {
        const channelId = frame.payload && frame.payload.channelId;
        const channel = channels.get(channelId);
        if (!channel) {
          send(ws, { type: "mux-error", payload: { code: "mux_unknown_channel", message: "channel is not open", channelId } });
          return;
        }
        const dataBase64 = frame.payload && frame.payload.dataBase64;
        if (typeof dataBase64 === "string") {
          handleInput(channel, Buffer.from(dataBase64, "base64").toString("utf8"));
        }
        return;
      }
      case "mux-channel-close":
        stopChannel(frame.payload && frame.payload.channelId, frame.payload && frame.payload.reason);
        return;
      case "mux-ping":
        send(ws, { type: "mux-pong", payload: { sentAt: frame.payload.sentAt, receivedAt: Date.now() } });
        return;
      default:
        return;
    }
  }

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname = "/";
    let token = "";
    try {
      const url = new URL(request.url || "/", "ws://127.0.0.1");
      pathname = url.pathname;
      token = url.searchParams.get("token") || "";
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (pathname !== "/" && pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (authToken && token !== authToken) {
        ws.send(JSON.stringify({ type: "error", payload: { message: "Unauthorized bridge token", code: "unauthorized" } }));
        ws.close(4001, "unauthorized");
        return;
      }
      ws.on("message", (raw) => {
        let frame;
        try {
          frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
        } catch {
          return;
        }
        if (frame && typeof frame.type === "string") {
          handleFrame(ws, frame);
        }
      });
      ws.on("close", () => {
        for (const [channelId, channel] of Array.from(channels.entries())) {
          if (channel.ws === ws) {
            stopChannel(channelId, "transport closed");
          }
        }
      });
    });
  });

  return {
    recorded,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, resolve);
      });
      const address = httpServer.address();
      return { host, port: address.port };
    },
    emitChannelMessage(message, channelId) {
      const selected = channelId
        ? channels.get(channelId)
        : Array.from(channels.values()).pop();
      if (!selected) {
        throw new Error("fixture has no open channel");
      }
      sendChannelMessage(selected.ws, selected.id, message);
    },
    get openChannelCount() {
      return channels.size;
    },
    async close() {
      for (const channelId of Array.from(channels.keys())) {
        stopChannel(channelId, "fixture shutting down");
      }
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {}
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
