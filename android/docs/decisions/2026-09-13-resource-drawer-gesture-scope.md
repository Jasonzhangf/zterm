# Resource drawer gesture scopes

The resource drawer owns shell drag gestures only on its explicit handle. Files,
web, remote stream, and toolbar surfaces each bind a typed page and runtime scope
and stop pointer/touch propagation at that boundary. Nested content therefore
cannot close or expand the drawer while its own interaction is active.

The remote window keeps its own gesture runtime. This decision changes only
client pointer routing; it does not alter daemon, tmux, shell, or iTerm state.
