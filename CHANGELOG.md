# Changelog

All notable changes to `@localflow/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/localflow-ai/localflow-core/compare/0.2.0...HEAD
[0.2.0]: https://github.com/localflow-ai/localflow-core/releases/tag/0.2.0
[0.1.5]: https://github.com/localflow-ai/localflow-core/releases/tag/0.1.5
