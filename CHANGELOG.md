# Changelog

All notable changes to `@localflow/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `LocalAssistantConfig.appContext?: string` — app-supplied domain context, prepended to the system prompt on every turn (e.g. "the active 'events' dataset is this proxy's request log; 'events' always means log entries"). Lets a specialised/embedded assistant interpret the user's wording in its domain instead of mis-reading generic terms.
- `LocalAssistantConfig.modelSize?: 'small' | 'medium' | 'large'` and `LocalAssistant.modelSize` getter/setter — capability tier of the active model. `'small'` switches `prompt()` to a lean, **code-only** protocol for local/edge models (e.g. Qwen-Coder via Ollama): a compact system prompt, plain-text output parsed directly as the formula, code-only conversation history, and no self-heal retries. `'medium'`/`'large'` (default when unset) keep the full JSON protocol. Pairs with `LLMModelInfo.size`.
- `LLMModelInfo.size?: 'small' | 'medium' | 'large'` — capability tier reported by `getAvailableLLMs()` (sourced from the proxy's `llm-configs.json`), so the client can pick prompt verbosity per model.
- `math` sandbox global — formulas can now use [math.js](https://mathjs.org) (as `math`) for statistics, linear algebra and regression (e.g. least-squares polynomial fitting via `math.lusolve`), alongside the existing `echarts`/`L`/`turf`/`XLSX`/`jsPDF` globals.
- **`'ollama'` `LLMProtocol`** — `LocalProxy` now supports Ollama's **native** `/api/chat` endpoint (protocol `'ollama'`), the only path that can control a thinking model's reasoning. Ollama's OpenAI-compat `/v1` endpoint silently ignores `reasoning_effort` / `think` / template kwargs, so a thinking model (e.g. qwen3) always reasons there — slow, and its `<think>` output can break code-only parsing.
- **`LLMRequest.options.reasoningEffort?: 'low' | 'medium' | 'high'`** — unified reasoning-depth control mapped per protocol: OpenAI `reasoning_effort`, Gemini thinking level, Ollama `think` (`'low'` ⇒ thinking off on binary-thinking models). Overrides the model's server-side default.
- **`LLMModelInfo.reasoningEffort?: 'low' | 'medium' | 'high'`** — the model's default reasoning depth, reported by `getAvailableLLMs()` (from `llm-configs.json`), so the proxy can apply it without the client having to.

### Fixed
- `parseMoney` now also strips the generic currency sign `¤` (U+00A4), alongside `€`/`$`/`£`/`¥`/`₹`. Some PDFs — notably French/euro statements — draw `€` at the Latin-1 `0xA4` slot with no `ToUnicode` map, so extraction faithfully yields `¤`; `parseMoney` previously treated such amounts as `NaN`, silently dropping every monetary cell (an entire positions table could extract to zero rows while quantities still parsed). Purely additive — amounts that already parsed are unchanged.
- Sandbox `console.*` now renders `Error` objects as `Name: message` instead of `{}` — previously `JSON.stringify(err)` dropped the message (Error properties are non-enumerable), so a formula's runtime error surfaced in the logs as an empty object.
- Sandbox now tolerates a formula that returns a bare HTML string (wrapped as `{ html, data: null, reset }`) — common output from small/local models.

## [0.4.1] — 2026-06-19

### Added
- `LLMMessage.context?: string` — machine-generated preamble for a turn (e.g. the previous run's execution trace). `callLLM()` forwards it to the model prepended to `content`, but the proxy excludes it from the per-message prompt-char limit (`content` is the user's own input). Used to carry the formula-execution trace at the conversation tail.

### Fixed
- Follow-up prompts after a formula run no longer trip the proxy's `maxPromptChars`. The previous run's execution trace (console output + data preview, often several KB) was prepended to the next user message and counted as the user's input, so self-heal / follow-up turns returned `413`. The trace now travels as message `context` (forwarded, uncounted) and stays at the conversation tail — the cacheable system prompt (which carries the PDF text) is left untouched.

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

[Unreleased]: https://github.com/localflow-ai/localflow-core/compare/0.4.1...HEAD
[0.4.1]: https://github.com/localflow-ai/localflow-core/compare/0.4.0...0.4.1
[0.4.0]: https://github.com/localflow-ai/localflow-core/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/localflow-ai/localflow-core/releases/tag/0.3.0
[0.2.0]: https://github.com/localflow-ai/localflow-core/releases/tag/0.2.0
[0.1.5]: https://github.com/localflow-ai/localflow-core/releases/tag/0.1.5
