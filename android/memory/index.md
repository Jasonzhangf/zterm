# Memory Index

Index stores short titles, tags, and detail paths. Open the linked Markdown detail for content.

## Raw sources

- [Plan](plan.jsonl)
- [Path](path.jsonl)
- [Knowledge](knowledge.jsonl)
- [Lesson](lesson.jsonl)

## Level 1 — reviewed critical

_Empty._

## Level 2 — reviewed reusable

_Empty._

## Level 3 — new or unreviewed

### TOML configuration and credential boundary
- tags: `config`, `credential`, `migration`, `relay`, `security`, `toml`
- details: [L3/zterm-config-and-credential-target.md](L3/zterm-config-and-credential-target.md)

### Cordis client composition target
- tags: `client`, `composition`, `cordis`, `lifecycle`, `plugin`, `target`
- details: [L3/zterm-cordis-client-target.md](L3/zterm-cordis-client-target.md)

### Separate verified implementation from confirmed target design
- tags: `architecture`, `evidence`, `function-map`, `implementation-truth`, `target-truth`
- details: [L3/zterm-current-runtime-truth-separation.md](L3/zterm-current-runtime-truth-separation.md)

### Relay control and physical route target
- tags: `android-service`, `control-plane`, `relay`, `route`, `tailscale`, `udp`
- details: [L3/zterm-relay-and-route-target.md](L3/zterm-relay-and-route-target.md)

### Confirmed terminal daemon buffer and renderer contract
- tags: `absolute-row`, `buffer`, `daemon`, `renderer`, `rolling-window`, `terminal`
- details: [L3/zterm-terminal-buffer-target-contract.md](L3/zterm-terminal-buffer-target-contract.md)

### Terminal data owner path
- tags: `flow`, `frame-assembly`, `mirror`, `owner`, `sparse-buffer`, `terminal`, `ui`
- details: [L3/zterm-terminal-data-owner-path.md](L3/zterm-terminal-data-owner-path.md)

## Skill description candidates

Base budget: 8 lines. Copy the compact lines into the project Skill `description` after manual architecture deduplication. Fill level 1 first; use level 2, then level 3, only for remaining slots.

- L3: TOML configuration and credential boundary (knowledge) [config,credential,migration,relay,security,toml] -> L3/zterm-config-and-credential-target.md
- L3: Cordis client composition target (plan) [client,composition,cordis,lifecycle,plugin,target] -> L3/zterm-cordis-client-target.md
- L3: Separate verified implementation from confirmed target design (lesson) [architecture,evidence,function-map,implementation-truth,target-truth] -> L3/zterm-current-runtime-truth-separation.md
- L3: Relay control and physical route target (path) [android-service,control-plane,relay,route,tailscale,udp] -> L3/zterm-relay-and-route-target.md
- L3: Confirmed terminal daemon buffer and renderer contract (plan) [absolute-row,buffer,daemon,renderer,rolling-window,terminal] -> L3/zterm-terminal-buffer-target-contract.md
- L3: Terminal data owner path (path) [flow,frame-assembly,mirror,owner,sparse-buffer,terminal,ui] -> L3/zterm-terminal-data-owner-path.md
