// Interactive terminal client for the V2 shell window panes.
//
// One handle owns one SSE stream and one wterm renderer for a real V1 session.
// The renderer element is cached per member so a shell re-render only re-attaches
// the existing surface instead of reconnecting or recreating the terminal.

const ATTACH_TIMEOUT_MS = 8000
const WTERM_MODULE_URL = new URL("./pane-terminal.bundle.js", import.meta.url).href

let wtermModulePromise = null

function loadWTerm() {
  if (!wtermModulePromise) {
    wtermModulePromise = import(WTERM_MODULE_URL)
  }
  return wtermModulePromise
}
function typedError(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.category = "terminal"
  error.retryable = true
  if (details !== undefined) {
    error.details = details
  }
  return error
}
export function createPaneTerminalClient({ api, attachTimeoutMs = ATTACH_TIMEOUT_MS } = {}) {
  const handlesByMemberId = new Map()

  function createHandle(member) {
    const memberId = member.memberId
    const sessionId = member.sessionId || member.name
    let source = null
    let openPromise = null
    let openPromiseGeneration = -1
    let resolveOpen = null
    let terminal = null
    let terminalElement = null
    let terminalReady = false
    let bodyActive = false
    let deliveredFrameCount = 0
    let cols = 80
    let rows = 24
    let attachTimer = null
    const backlog = []
    const frameListeners = new Set()
    let streamGeneration = 0
    // Keystrokes arrive one keydown at a time. Each POST must finish before the
    // next starts, or the daemon/tmux receive characters out of order.
    let writeQueue = Promise.resolve()

    function clearAttachTimer() {
      if (attachTimer) {
        clearTimeout(attachTimer)
        attachTimer = null
      }
    }

    // Drop the failed stream bookkeeping so a later attach/resume opens exactly
    // one fresh stream. The generation bump keeps late ready/buffer/error
    // callbacks from the dead stream out of the live handle, and stops open()
    // from reusing a promise that already settled for the failed stream.
    function releaseFailedStream() {
      streamGeneration += 1
      source = null
      openPromise = null
      resolveOpen = null
    }

    function enqueueInput(data) {
      const run = writeQueue.then(() => api.sendInput(sessionId, data, { raw: true }))
      writeQueue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    function applyFrame(payload) {
      if (!bodyActive) return
      const frame = payload && payload.frame
      if (frame && Number.isFinite(frame.cols) && Number.isFinite(frame.rows) && frame.cols > 0 && frame.rows > 0) {
        cols = frame.cols
        rows = frame.rows
      }
      deliveredFrameCount += 1
      const ansi = typeof payload?.ansi === "string" ? payload.ansi : ""
      if (terminal && terminalReady) {
        terminal.resize(cols, rows)
        terminal.write(ansi)
      } else {
        backlog.push(ansi)
      }
      for (const listener of frameListeners) {
        try {
          listener({ ansi, frame })
        } catch {
          // A single pane subscriber must not disturb the shared stream.
        }
      }
    }

    const handle = {
      handleId: `pane-${memberId}`,
      memberId,
      sessionId,
      status: "connecting",
      lastError: null,

      getSnapshot() {
        return {
          handleId: handle.handleId,
          memberId,
          sessionId,
          status: handle.status,
          subscriptionState: bodyActive ? "active" : "suspended",
          deliveredFrameCount,
        }
      },

      isBodyActive() {
        return bodyActive
      },

      suspend() {
        bodyActive = false
        clearAttachTimer()
        // Invalidate callbacks from the stream that is being closed. A late
        // ready/buffer/error event must not reactivate a hidden pane.
        streamGeneration += 1
        // Suspending stops the body fetch: close the SSE so hidden panes do
        // not keep receiving frames. The handle, renderer, and session stay
        // alive for reuse; resume() reopens the stream on demand.
        try {
          source?.close()
        } catch {}
        source = null
        const settle = resolveOpen
        openPromise = null
        resolveOpen = null
        settle?.(handle)
      },

      async resume() {
        bodyActive = true
        if (!source && handle.status !== "disconnected") {
          await handle.open()
        }
      },

      open() {
        if (openPromise && openPromiseGeneration === streamGeneration) {
          return openPromise
        }
        openPromiseGeneration = streamGeneration
        openPromise = new Promise((resolve) => {
          resolveOpen = resolve
          let settled = false
          let attachSettled = false
          const openGeneration = streamGeneration

          const resolveHandle = () => {
            if (!settled) {
              settled = true
              resolve(handle)
            }
          }

          const finishAttach = (status, error) => {
            if (openGeneration !== streamGeneration || attachSettled || handle.status === "disconnected") {
              return
            }
            attachSettled = true
            clearAttachTimer()
            if (status === "attached") {
              bodyActive = true
            }
            handle.status = status
            handle.lastError = error || null
            if (status === "unavailable") {
              releaseFailedStream()
            }
            resolveHandle()
          }

          const settleError = (error) => {
            if (openGeneration !== streamGeneration || handle.status === "disconnected") {
              return
            }
            attachSettled = true
            clearAttachTimer()
            bodyActive = false
            handle.status = "unavailable"
            handle.lastError = error || null
            releaseFailedStream()
            resolveHandle()
          }

          const startPending = () => {
            if (openGeneration !== streamGeneration || attachSettled || handle.status === "disconnected") {
              return
            }
            attachTimer = null
            handle.status = "starting"
            handle.lastError = null
            resolveHandle()
          }

          attachTimer = setTimeout(startPending, attachTimeoutMs)
          try {
            source = api.openTerminalStream(sessionId, {
              onReady: () => {
                if (openGeneration !== streamGeneration) return
                finishAttach("attached")
              },
              onBuffer: (payload) => {
                if (openGeneration !== streamGeneration) return
                // A real frame is the first observable body and proves attach.
                if (!attachSettled) {
                  finishAttach("attached")
                }
                applyFrame(payload)
              },
              onError: settleError,
            })
          } catch (error) {
            finishAttach("unavailable", error)
          }
        })
        return openPromise
      },

      subscribe(listener) {
        frameListeners.add(listener)
        return () => frameListeners.delete(listener)
      },

      async writeInput(data) {
        if (typeof data !== "string" || data.length === 0) {
          return { ok: false, error: typedError("INPUT_INVALID", "Terminal input is empty.") }
        }
        return enqueueInput(data)
      },

      async mount(slot) {
        if (!slot) {
          return
        }
        if (terminalElement) {
          if (terminalElement.parentNode !== slot) {
            slot.appendChild(terminalElement)
          }
          if (terminal && terminalReady) {
            terminal.resize(cols, rows)
            terminal.focus?.()
          }
          return
        }
        const container = document.createElement("div")
        container.className = "v2-pane-wterm"
        container.style.width = "100%"
        container.style.height = "100%"
        slot.appendChild(container)
        terminalElement = container
        try {
          const { WTerm } = await loadWTerm()
          const wt = new WTerm(container, {
            cols,
            rows,
            autoResize: true,
            cursorBlink: true,
            onData: (data) => {
              void handle.writeInput(data)
            },
          })
          terminal = wt
          await wt.init()
          terminalReady = true
          for (const chunk of backlog.splice(0, backlog.length)) {
            wt.write(chunk)
          }
          wt.resize(cols, rows)
          wt.focus?.()
        } catch (error) {
          handle.status = "unavailable"
          handle.lastError = { code: "TERMINAL_RENDERER_FAILED", message: String(error?.message || error) }
          if (container.isConnected) {
            container.remove()
          }
          terminalElement = null
          const notice = document.createElement("div")
          notice.className = "v2-error-notice"
          notice.textContent = `TERMINAL_RENDERER_FAILED: ${handle.lastError.message}`
          slot.appendChild(notice)
        }
      },

      disconnect() {
        clearAttachTimer()
        streamGeneration += 1
        try {
          source?.close()
        } catch {}
        source = null
        try {
          terminal?.destroy?.()
        } catch {}
        terminal = null
        terminalReady = false
        terminalElement = null
        bodyActive = false
        handle.status = "disconnected"
      },
    }

    return handle
  }

  async function attachSession(member) {
    if (!member || !member.memberId) {
      throw typedError("TERMINAL_MEMBER_REQUIRED", "A member id is required to attach a terminal.")
    }
    if (!api || typeof api.openTerminalStream !== "function") {
      throw typedError("TERMINAL_CLIENT_UNAVAILABLE", "The daemon terminal API is not available.")
    }
    const existing = handlesByMemberId.get(member.memberId)
    if (existing && existing.status === "attached") {
      return existing
    }
    const handle = existing || createHandle(member)
    handlesByMemberId.set(member.memberId, handle)
    await handle.open()
    return handle
  }

  async function writeInput(handle, data) {
    return handle.writeInput(data)
  }

  async function disconnect(handle) {
    handle.disconnect()
    handlesByMemberId.delete(handle.memberId)
    return { ok: true }
  }

  async function suspend(handle) {
    handle.suspend()
    return { ok: true }
  }

  async function resume(handle) {
    handle.resume()
    return { ok: true }
  }

  return {
    attachSession,
    createSession: attachSession,
    writeInput,
    disconnect,
    suspend,
    resume,
    getHandle: (memberId) => handlesByMemberId.get(memberId) || null,
  }
}
