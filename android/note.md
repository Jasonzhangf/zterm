# note

## Input path audit (2026-06-19)

### Full client-side input chain
```
domInputController.handleInput() / handleBeforeInput()
  → sendTerminalInput(value)
    → onInputRef.current(sessionId, value)  [sessionIdRef.current = sessionId prop]
      → TerminalView.onInput(sessionId, data)
        → handleTerminalInput(sessionId, data)
          → sendInput(sessionId, data)      [via useSession context]
            → sendInputRuntime() / sendInputThroughSessionTransport()
              → sendSocketPayload(sessionId, ws,
                  JSON.stringify({type:'input', payload: data}))
                → WebSocket.send()           [ws.readyState === OPEN]
                  → daemon receives JSON {type:'input', payload}
                    → PTY.write(data)        [bottleneck: PTY write may block]
```

### Bottleneck analysis
- After tab switch, `scheduleInputHeadRefresh` captures stale `readSessionTransportSocket` closure.
- `queueMicrotask` delay means head refresh may target wrong transport.
- Fix: add session ID version/epoch check before `requestSessionBufferHead` call.
- `sessionIdRef.current = sessionId` updates synchronously on prop change (line 484).
- `domInputController` uses `sessionIdRef.current` on next input event → correct if no pending input.
- Risk: rapid tab switch + pending composition may route to wrong session.
- `setTimeout(0)` + `setTimeout(32)` retry → 32ms minimum latency on every commit.
- For high-frequency typing, this adds at least 32ms per batch.

### Daemon PTY write (in `server.cjs`)
```javascript
ws.on("message", (msg: Buffer | string) => {
  const input = typeof msg === "string" ? msg : msg.toString("utf-8");
  ptyProcess.write(input);  // blocking write to PTY
});
```

### Status
- TypeScript: `npx tsc --noEmit` → **No errors found** ✓
- All prior R5/R2/R1 work remains intact.
- Need: daemon source to audit PTY queue depth + write scheduling.
