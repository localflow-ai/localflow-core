# localflow-core

The `@localflow/core` library — metadata-first AI framework (`LocalAssistant`, `LocalProxy`, `ProxyClient`). Browser-only at runtime; Node is needed only to build. Published to npm. Part of the multi-repo `localflow/` workspace (sibling repos: proxy, app, console, examples). The public API is documented in `README.md` — keep it current when the API changes.

## Build
- `npm run build` — `tsc` → `dist/` (`.js` + `.d.ts`). `npm run dev` — `tsc --watch`.
- **No `prepublishOnly` hook**: you must run `npm run build` before `npm publish`, or you ship a stale `dist/`.
- In-workspace dev (app/console/examples) aliases `localflow-core` to `src/` via Vite — no prebuild needed; only the npm publish path needs `dist/`.

## Docs to keep current
- **`CHANGELOG.md`** — hand-maintained, [Keep a Changelog](https://keepachangelog.com/) format. Add an entry under `## [Unreleased]` for any change to the public surface (exported API, events, config shape).
- **`ROADMAP.md`** — when a roadmap item ships, move it into the CHANGELOG.

## Release checklist
1. Bump `version` in `package.json` (SemVer).
2. In `CHANGELOG.md`, rename `[Unreleased]` to the new version with today's date; add a fresh empty `[Unreleased]`; update the compare links at the bottom.
3. `npm run build`.
4. `npm publish`.
5. `git tag <version>` (unprefixed, e.g. `0.2.0`) and `git push origin <version>`.

> CHANGELOG documents `0.1.5` and `0.2.0`+. The same-day `0.1.1`–`0.1.4` prototype tags exist but aren't worth documenting — ignore them.
