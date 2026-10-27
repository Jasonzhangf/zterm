# win

Windows remote-access client alpha. DAGPipe graph truth is `../android/docs/dagpipe/windows-remote-access-client.graph.json`.

Before building or testing, ensure `packages/shared/dist` exists. A normal `pnpm install` generates it through the shared package's `prepare` script; after an install-skipped checkout, run `pnpm --dir packages/shared run build` first.
