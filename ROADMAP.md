# Roadmap

Directions under consideration for `@localflow/core` — not commitments or a release schedule.

- **Additional LLM backends** — Mistral, Ollama.
- **Streaming LLM client** — a `callLLMStream()` (and matching `Proxy` method) that consumes the proxy's streaming `/common/genai` (SSE) and yields text deltas, for incremental rendering. Pairs with the proxy-side streaming endpoint; most useful for plain chat (the metadata-first `prompt()` needs the full JSON before it can run the formula).
- **Interactive formula results** — action buttons returned by formulas.
- **Async / streaming formula execution.**
- **Dependency-compatibility API** — move the `AnalysisDependencies` compatibility check into core (currently reimplemented app-side in `localflow-app`): exported pure functions `isDepsCompatible(deps, columns, datasets)` / `pruneDependencies(...)`, plus a `LocalAssistant.canExecute(deps)` convenience over the current context. Optionally a richer `checkDependencies(...)` that reports which columns/datasets are missing.

Have a use case for one of these, or want to contribute it? Open an issue or a pull request.

For shipped changes, see [CHANGELOG.md](CHANGELOG.md).
