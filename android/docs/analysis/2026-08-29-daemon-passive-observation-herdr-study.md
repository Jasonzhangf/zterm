# Daemon passive observation study: Herdr reference and zterm boundary

Status: implementation in progress; canonical build/live gates remain pending.

Feature: `daemon.session_agent_status_probe`  
Owner: `daemon.session_catalog`  
Non-owners: client session drawer, terminal renderer, mirror store, and agent
processes.

## Decision

The agent is a black box, but the daemon is allowed to classify a status from
an explicit, bounded passive-evidence contract. The daemon is the sole status
owner: it combines process/job/group evidence, a configured known-agent
manifest rule, screen/ANSI/OSC evidence, and lifecycle stabilization. It must
return `unknown` or `error` when that contract is incomplete or a read fails;
it must never use “has output => running” or “no output => idle” heuristics.
The daemon does not register agents, request heartbeats, read
`@zterm_agent_*`, call Herdr APIs, or infer identity from pane title, cwd,
`/root`, Codex task text, or legacy Herdr identity.

The first approved slice is therefore a passive observation record:

| Fact | Evidence source | Truth owner | Not allowed to mean |
| --- | --- | --- | --- |
| session exists | daemon-visible catalog enumeration | daemon session catalog | agent exists/available |
| foreground process label | exact session process probe | daemon session catalog | agent identity |
| process-group presence/liveness | process-group observation | daemon session catalog | standalone running proof |
| recent output/content change | exact session capture/readback | daemon session catalog | standalone running/idle proof |
| OSC title/progress seen | terminal byte/readback observation | daemon session catalog | unvalidated semantic state |
| manifest rule match | deterministic daemon-side rule | daemon session catalog | client-side identity guess |
| lifecycle stabilization | startup/exit/replacement/sequence state | daemon session catalog | transient state publication |
| read failure/disappearance | explicit observation error/gap | daemon session catalog | cached success |

The daemon may publish a typed `status` (`running`, `idle`, `unknown`, or
`error`) alongside the evidence facts in the `sessions` control projection.
The status is daemon-owned and must include enough typed reason/evidence state
to distinguish unsupported evidence from read failure. These fields must not
enter terminal body, mirror data, metadata, or client decision state. During
phase 1 the client/drawer has zero consumers. During phase 2 the drawer may
display the already-published daemon status only; it must not revalidate,
reclassify, maintain, gate availability, or disable connection. Catalog
presence remains the display/connectability truth.

## Herdr source study (reference only)

The reference was read from the public Herdr repository at commit `master`
(2026-08-29): <https://github.com/herdrdev/herdr>.

### Process/job/group and lifecycle

- `src/detect/mod.rs:339-357` exposes foreground job, foreground group leader,
  and foreground process-group probes.
- `src/pane.rs:320-323` obtains the foreground job; `:439-447` keeps
  change-tracking tied to kernel-observed groups; `:623-650` first examines
  the foreground job and then the group leader/process members.
- `src/pane/agent_detection.rs:12-13` defines a 3-second startup grace window.
  The same module accepts `agent_changed` and `process_exited` as explicit
  lifecycle inputs (`:80-89`, `:176-184`), so a replacement/exit cannot inherit
  the prior observation state.

zterm translation: the process/group/output layer is input evidence, not a
heuristic classifier. The daemon classifier may publish status only after
manifest evidence and lifecycle rules satisfy the contract. Exit, replacement,
or disappearance invalidates prior evidence and yields a stabilized new status
or explicit gap/error; it never reuses stale state.

### Known-agent manifest and screen matching

- `src/detect/manifest.rs:16-25` defines detection input as screen text plus
  OSC title/progress strings.
- `src/detect/manifest.rs:138-181` defines a deny-unknown-fields manifest with
  aliases, ordered rules, regions, visible flags, and boolean/regex gates.
- `src/detect/manifest.rs:215-230` includes `idle`, `working`, `blocked`, and
  `unknown` in Herdr's semantic enum.
- `src/detect/manifest.rs:366-370` dispatches an identified agent through the
  manifest evaluator.

zterm translation: Herdr's manifest demonstrates the required shape of a
deterministic known-agent rule source, but zterm must not import Herdr's
evaluator or runtime/API. A zterm-owned manifest contract may classify only
when process/group plus screen/ANSI/OSC evidence and lifecycle stabilization
agree. Missing/ambiguous rules produce `unknown`; failed reads produce
`error`. A process label, title, cwd, or output fragment alone is insufficient.

### Screen/ANSI/OSC observations

- `src/pane/terminal.rs:454-464` exposes bottom detection text and retained OSC
  state separately.
- `src/pane/osc.rs:446-457` bounds untrusted OSC title/progress payloads to 256
  characters and documents OSC 0/2 title plus OSC 9 progress capture.
- `src/pane/osc.rs:466-495` parses complete OSC bodies and retains the latest
  title/progress; `:519-526` clears retained evidence when the foreground
  process changes.
- `src/pane/terminal.rs:1262-1272` observes PTY bytes and obtains detection
  text from the terminal state; `:2542-2548` reads the bottom text used by the
  detector.

zterm translation: capture/readback proves that output or an escape signal was
observed. A manifest rule may interpret a complete, bounded signal as one
component of status evidence, but the client never interprets it. Clear/replace
boundaries are required so a new process cannot inherit stale evidence.

### Content sequence, idle-scan skip, pending confirmation, stabilization

- `src/pane/agent_detection.rs:5-13` defines 100ms pending-idle recheck,
  three confirmations, a 700ms cap, an 800ms stable-signal refresh, and the
  3-second startup grace window.
- `:91-103` skips an idle screen scan only when the agent is unchanged, the
  process has not exited, no idle confirmation is pending, and the detection
  content sequence is unchanged.
- `:140-168` publishes state changes and periodically refreshes stable visible
  signals.
- `:186-211` holds a working-to-plain-idle transition while pending
  confirmation is active, then publishes only after confirmation/cap handling.
- `:238-280` derives the next publish decision through stabilization and the
  transition gate.

zterm translation: these mechanisms define the daemon classifier's test
questions—sampling identity, content sequence, pending confirmation, and
stabilization—but not a client state machine. The implementation must avoid
idle-scan skips when content, process identity, lifecycle, or pending
confirmation changed. Stable `running`/`idle` publication requires the
approved evidence contract; otherwise publish `unknown` or `error`.

## Resource/module/function/mainline map

| Node | Owner and allowed edge | Forbidden edge | Verification |
| --- | --- | --- | --- |
| `resource.tmux_session` | daemon session catalog reads exact session | client or drawer probes tmux | catalog ownership tests |
| `resource.daemon_session_observation` | catalog builds typed facts and daemon-owned status from process/job/group + manifest + screen/ANSI/OSC + lifecycle evidence | mirror/body/metadata writes; client classification | passive observation/status unit tests |
| `resource.session_catalog_control_projection` | catalog serializes daemon status and evidence on `sessions` control frame | client reclassification or payload body | protocol/catalog tests |
| `resource.mirror_store` | unchanged terminal mirror owner | observation fields or agent state | boundary/import gate |
| `resource.ui_projection` | drawer consumes presence only | observation interpretation/status gating | drawer ownership gate |

Mainline:

```text
daemon terminal-control runtime
  -> session catalog enumeration
  -> exact-session passive observation reader
  -> typed catalog control projection
  -> client transport (opaque field)
  -> drawer presence projection only
```

There is no edge from agent process to daemon registration/heartbeat, no edge
from drawer to tmux/process probing, and no edge from observation to terminal
body or mirror truth.

## Test design before implementation approval

### White-box

Positive cases:

1. Exact session target returns process label and process-group presence.
2. Non-empty capture changes `recentOutput`; unchanged capture does not claim
   activity.
3. OSC title/progress bytes set only their corresponding observed flags.
4. Session catalog includes the typed observation only for the qualified
   daemon backend.

Negative cases:

1. Empty/insufficient process/output produces `unknown`, never inferred idle or
   running.
2. A title, cwd, `/root`, Codex task string, or legacy Herdr identity cannot
   create an agent status.
3. Unrelated session output cannot contaminate the target session.
4. tmux read failure and session disappearance remain explicit gap/error; they
   cannot reuse a prior successful observation.
5. Phase 1 client/drawer imports do not consume the field. Phase 2 tests may
   assert display-only projection and reject client reclassification,
   availability gating, or state ownership.

### Black-box and lifecycle

Use an isolated tmux server with explicit session targets. Cover process/job/
group changes, manifest match and mismatch, process replacement, process exit,
output sequence change, startup grace, pending idle confirmation, stable
running/idle publication, unknown/error, empty output, ANSI/OSC bytes, and
cleanup. The fixture must prove session enumeration and daemon-owned status
through the actual `sessions` control frame, not only direct helper calls. Do
not create any agent registration or heartbeat fixture.

### Known limits

The daemon may publish `running` or `idle` only when its explicit evidence,
manifest, and stabilization contract proves that classification. Passive
output alone cannot do so. `available` and `unavailable` remain outside this
feature and are never derived from status. Installation/restart/live
verification and AGY review remain required after implementation.

## Acceptance

1. The daemon has one status classifier owner and one mainline call from
   catalog construction; no client, drawer, mirror, or Herdr runtime path
   classifies status.
2. Positive tests prove evidence-backed `running` and `idle` results using
   manifest plus process/group and screen/ANSI/OSC/lifecycle inputs.
3. Negative tests prove ambiguous/insufficient evidence is `unknown`, failed
   reads are `error`, and output-only/no-output-only heuristics never produce
   running/idle.
4. Replacement, exit, startup grace, pending confirmation, content sequence,
   and stabilization invalidate or delay stale status.
5. Phase 1 online daemon control-frame evidence shows typed status and facts;
   client consumption remains zero. Only after that evidence passes may phase 2
   add display-only client projection.
