# AGENTS.md

接手這個專案前先讀 `docs/HANDOFF.md`（進度、下一步、使用者的規則、容易踩的坑）。

- 和使用者溝通、介面、文件、commit、PR 一律用繁體中文。
- 使用者說「合併」才合併 PR；完成一項就開 PR、等 CI 綠燈後回報。
- 已知限制與待辦只記在 `docs/backlog.md`。
- 改完跑：`pnpm typecheck && pnpm test`；開 PR 前加跑 `pnpm e2e`（與 `pnpm e2e:desktop`），寫法見 `e2e/README.md`。
