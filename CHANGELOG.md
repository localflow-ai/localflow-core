# Changelog

All notable changes to `@localflow/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-06-19

### Added
- **Authorization vocabulary** — exported `Capability` / `PermissionLimits` / `EffectivePermissions` types, `DENY_ALL` / `ALLOW_ALL`, and helpers `can()` / `isModelAllowed()` / `isApiAllowed()`. `ProxyClient.getPermissions()` fetches the proxy's resolved set from `GET /permissions`; a proxy without the endpoint (404) is treated as unrestricted (`ALLOW_ALL`, legacy), other errors fail closed (`DENY_ALL`). Client gating is UX only — the proxy enforces. Single capability vocabulary shared with the proxy; see `localflow-proxy/docs/permissions.md`.
- `LocalAssistant.sandboxTheme` getter/setter — lets the host change the sandbox's Tailwind theme after construction (e.g. to match the app's current skin/dark mode before building a result). Previously settable only via the constructor.
- `ApiConfig.description?: string` — a human-readable, end-user-facing description for an external API (the proxy already returns it via `GET /common/api-config`). Distinct from `prompt`, which is the LLM-facing instruction.
- `LLMMessage.attachments?: LLMAttachment[]` — messages may now carry files (`{ name, mimeType, data }`, base64 without the `data:` prefix). `ProxyClient.callLLM()` forwards them to the proxy, which maps them into each provider's multimodal format. New exported type `LLMAttachment`.
- `ProxyClient.getPublicConfig()` — reads the proxy's public policy (unauthenticated), notably `safeMode`. When `safeMode` is true the proxy refuses to forward attachments, so clients should hide any "send file to AI" affordance.

### Fixed
- Sandbox helpers (`parseMoney`/`parseNum`/`splitCols`) are now bound to canonical `var` names when injected into the sandbox document. Previously a production minifier could rename the source functions, leaving the sandbox globals undefined and breaking formulas that call them (`"parseMoney is not defined"` at result-render time). Dev builds were unaffected because they aren't minified.
- PDF analyses no longer trip the proxy's per-message prompt-char limit. The extracted PDF text was concatenated into the user message, so it counted against `maxPromptChars` and a large document returned `413 Message exceeds the N-character limit`. The document text now travels in the system prompt instead — bounded by the upload-size limit at extraction time — leaving the user message just the question. Behaviour is otherwise unchanged (the text still reaches the model; self-heal/revision reuse the same system prompt).

## [0.3.0] — 2026-06-15

### Changed
- Renamed `runFormulaSilently(formula)` → `executeFormulaSilently(formula)` and enriched its return type: it now resolves with `{ data: unknown; logs: string[]; error?: string }` instead of `string[]`. This makes it the documented **headless** counterpart to `executeFormula` — identical hidden-iframe execution, returning the formula's `data` (and console `logs`) directly and emitting no events. _Breaking:_ callers that read the old `string[]` logs must destructure `.logs`.

## [0.2.0] — 2026-06-10

### Added
- Multi-protocol LLM support — Gemini, OpenAI (and OpenAI-compatible endpoints), and Anthropic, selectable via `llm.protocol`. Previously Gemini-only.

## [0.1.5] — 2026-06-01

### Added
- Published to npm as `@localflow/core`.
- PDF documents as first-class datasets — text extracted via the proxy, full document text injected into the LLM context.
- Data flow awareness — `data:local` / `data:proxy` / `data:llm` events, an animated status chip, a session-history popover, and a sandbox safety indicator.
- CRM connectors — Odoo and Salesforce authentication and data loading via `ProxyClient`.
- Runtime-configurable proxy URL, persisted in `localStorage`.
- Formula self-healing — `formulaHealingRetries` option; JS syntax errors are caught and silently retried before returning to the caller (default: 1).

[Unreleased]: https://github.com/localflow-ai/localflow-core/compare/0.4.0...HEAD
[0.4.0]: https://github.com/localflow-ai/localflow-core/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/localflow-ai/localflow-core/releases/tag/0.3.0
[0.2.0]: https://github.com/localflow-ai/localflow-core/releases/tag/0.2.0
[0.1.5]: https://github.com/localflow-ai/localflow-core/releases/tag/0.1.5
