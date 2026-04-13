# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-04-13

### Fixed

- **LightRAG Delay / Hang on mix mode**: Replaced full prompt (containing huge JSON metadata) with only the exact last user message as the recall query, drastically reducing backend latency. Truncated fallback queries to 800 characters to prevent Memory Exhaustion.
- **Hook stalls**: Added a 30s `AbortSignal` timeout to all interactions with LightRAG API to prevent OpenClaw from stalling forever when LightRAG hangs.
- **Endpoint update for speed**: Changed recall query endpoint from `/query` to `/query/data` to retrieve raw data, bypassing slow LLM generation (`only_need_context` was also injected). Extracting actual raw knowledge fragments from `result.references`.
- **Visibility**: Improved observability for `autoCapture` and `autoRecall` hooks with always-on (`warn`) logs including timing (`elapsedMs`) and response snippet previews.

## [0.3.0] - 2026-04-13

### Fixed

- **Critical: 404 on all API calls** — `AdapterClient` was targeting a custom
  adapter middleware layer (`/adapter/*` endpoints) that does not exist on the
  stock LightRAG Server. All calls now go directly to the LightRAG Server REST
  API:
  - `recall` → `POST /query`
  - `capture / ingest` → `POST /documents/texts` (batch) or
    `POST /documents/text` (single)
- **Wrong auth header** — changed `x-api-key` → `X-API-Key` to match the
  LightRAG Server `APIKeyHeader` security scheme.

### Added

- **`queryMode` config option** — allows choosing the LightRAG query strategy
  (`local`, `global`, `hybrid`, `naive`, `mix`, `bypass`). Default is `mix`
  which combines knowledge-graph traversal with vector search for best
  recall quality.
- `AdapterClient.health()` helper method mapping to `GET /health`.
- `queryMode` UI hint and JSON Schema entry in `openclaw.plugin.json`.

### Changed

- `AdapterClient` completely rewritten to speak directly to the LightRAG
  Server API instead of a separate adapter middleware.
- `ingest()` now formats each conversation item with role/sender/timestamp
  prefix before inserting as text documents in LightRAG.
- `listInbox()`, `inboxAction()`, and `retrievalFeedback()` return graceful
  stubs (LightRAG has no equivalent endpoints) — tools no longer throw.

## [0.2.0] - 2026-02-21

### Added
- USAGE.md with advanced configuration, custom hooks, and integration examples.
- Detailed use cases with code examples (USE_CASES.md).
- Comprehensive error reference table (ERRORS.md).
- Roadmap and missing features (TODO.md).
- TypeScript declaration file for OpenClaw plugin SDK (openclaw-plugin-sdk.d.ts).

### Changed
- Improved type safety in hooks (event validation, optional chaining).
- Updated README.md with technical limitations and performance metrics.
- Enhanced configuration schema alignment with OpenClaw standards.
- Package version bumped to 0.2.0.

### Fixed
- TypeScript compilation errors (missing module definitions).
- Insecure type handling in hooks (event.from, event.timestamp).
- Manifest completeness (added name, description, version).

## [0.1.0] - 2026-02-21

### Added
- First release: plugin ready for use with OpenClaw Gateway 2026.1+.
- Supports LightRAG local server v1.x.
- Auto‑ingestion and auto‑recall hooks.
- Configurable capture mode and debug logging.