# zterm Windows Memory

## 2026-07-11 Windows starts from daemon backend truth

- Windows client work must not start by copying terminal runtime, daemon mirror, buffer protocol, or renderer logic into `win/`.
- The first closeout target is `daemon.windows_wezterm_backend`: WezTerm is an external terminal/mux source, and ZTerm owns mirror snapshots and client-facing protocol.
- Windows desktop shell is a later owner under `win/` for window/menu/package/platform integration only.
