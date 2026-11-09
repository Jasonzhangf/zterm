# terminal-admission-composition-1107 host producer composition (candidate 413a4733)

Date: 2026-11-07 (PST) / 2026-11-08 (UTC)
Composition worktree: /Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107
Branch: daemon-terminal-admission-20261107
Base before merge: f9bb26fc (composition HEAD)
Producer candidate: host-adapter-terminal-target-producer-20261107 @ 413a4733 (base f9bb26fc)
Merge commit: 5971f8bd (merge into composition, fast-forward content, no conflict)
Dispatch: m1794110791884-605 (Jenny hands producer candidate 413a4733 to composition)

## What I did

- Consumed producer candidate 413a4733 into the composition worktree (merge 5971f8bd). The producer line was not modified; Emma's worktree keeps original owner and no concurrent rewrite of the producer branch happened.
- Ran a real composition probe (host-producer-composition-probe.mjs) that injects the host-adapter public probe into the members explicit-bind boundary through a dedicated `tmux -L` socket, records the persisted target, and records the daemon-side catalog domain.

## Composition chain verified (green)

1. Injected verified identity (machineId = connections-verified daemonHostId) -> `bindSession` observes the real tmux session and persists `terminalTarget {backend:"tmux", stableId:"$0"}` with `bindingGeneration` 1. Raw receipt: host-producer-composition-probe.txt.
2. No injected identity (probe machineId null) -> `bindSession` refuses with typed `BINDING_HOST_IDENTITY_UNAVAILABLE` and writes no binding and no generation. Confirms the producer's explicit "unavailable, do not invent" contract is preserved through composition.
3. Full focused composition suite at 5971f8bd (members + terminal-admission + terminal-admission-fail-closed + terminal-slice + terminal-input-raw + machine-terminal-consumer + host-probe): 73 tests / 73 pass / 0 fail. node --check PASS on all touched/added .mjs.

## Real remaining gap (needs master routing; not fabricatable in composition)

Producer/target domain mismatch:
- host-adapter producer returns raw tmux session id `stableId = "$0"`.
- daemon admission consumes the connections catalog whose stableId is the V1 mux encoded domain `tmux:v1:<url-encoded identity>`.
- Consequence: `resolveBindingTarget({binding, catalog})` compares producer target to catalog target, the domains differ, the exact match returns null, and admission stays `TERMINAL_TARGET_BINDING_UNAVAILABLE`. This is the correct fail-closed result, not a bug in either side alone.

This is a contract routing decision, not a composition-side shim. One of:
- host-adapters owner: make the probe emit the V1 mux stableId domain, or
- daemon/connections owner: make the daemon resolve against the raw session-id catalog domain the producer observes, or
- master ruling: define which domain is authoritative and route the single owner to convert at exactly one boundary.

Emma must not invent a mapping between the two domains, must not add a second stableId parser, and must not weaken resolveBindingTarget's exact-match rule. Reported for routing.

## Other still-open production gaps (unchanged, owned elsewhere)

- Real accounts login/grant/revocation composition.
- Production daemon bootstrap assembling accounts/connections/members/routing/machineTerminal (no production composition entry exists yet; only tests assemble admission).
- Committed frame + real input execution against a real V1 mux catalog once the domain gap is ruled.

## Git

Freeze held. Local commits only (merge 5971f8bd + evidence commit). No push/PR/merge to main/publish. Producer branch host-adapter-terminal-target-producer-20261107 untouched after handoff.
