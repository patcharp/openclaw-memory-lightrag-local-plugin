# OpenClaw Memory Plugin: LightRAG Local

This plugin integrates a **LightRAG Server** directly into OpenClaw as a memory backend, providing knowledge-graph-augmented semantic search, auto‑ingestion, and recall capabilities — with no intermediate adapter required.

## Features

- **Semantic memory search** via LightRAG Server REST API (`/query/data`, raw retrieval).
- **Auto‑ingestion** of conversation content (hooks‑based, fires on every AI turn).
- **Auto‑recall** of relevant memories before each AI turn.
- **Query mode locked to `naive`** for stable `/query/data` behavior.
- **Configurable capture modes** (`all` or `everything`).
- **Structured debug logging** — response time, byte sizes, item counts (only when `debug: true`).

## Architecture

```
OpenClaw Gateway
  └─ memory-lightrag-local plugin
       ├─ recall  → POST http://<host>:9621/query/data  (raw retrieval, bypass LLM)
       └─ ingest  → POST http://<host>:9621/documents/texts
```

The plugin speaks directly to the [LightRAG Server](https://github.com/HKUDS/LightRAG) REST API. No custom adapter middleware is needed.

## Installation

### Prerequisites

1. A running **LightRAG Server** (default port `9621`). See the [LightRAG repository](https://github.com/HKUDS/LightRAG) for setup instructions.
2. **OpenClaw Gateway** version 2026.1 or later.

### Install the plugin

```bash
openclaw plugins install -l ./memory-lightrag-local
```

Or from npm (once published):

```bash
openclaw plugins install @openclaw/memory-lightrag-local
```

### Configuration

Add to your `openclaw.json`:

```json5
{
  plugins: {
    slots: {
      memory: "memory-lightrag-local"
    },
    entries: {
      "memory-lightrag-local": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:9621",   // LightRAG Server default port
          apiKey: "your-api-key-here",
          autoIngest: true,
          autoRecall: true,
          maxRecallResults: 8,
          queryMode: "naive",                  // fixed: /query/data + naive only
          captureMode: "all",
          minCaptureLength: 10,
          debug: false
        }
      }
    }
  }
}
```

Restart the Gateway after configuration changes.

### Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | string | — | **Required.** LightRAG Server base URL (e.g. `http://127.0.0.1:9621`) |
| `apiKey` | string | — | **Required.** API key for the LightRAG Server (`X-API-Key` header) |
| `autoIngest` | boolean | `true` | Capture conversation turns and insert into LightRAG after each AI response |
| `autoRecall` | boolean | `true` | Inject relevant memories into the AI context before each turn |
| `maxRecallResults` | number | `8` | Max memory snippets injected per turn (1–20) |
| `queryMode` | string | `"naive"` | Fixed to `naive` (other values are ignored at runtime) |
| `captureMode` | string | `"all"` | `all`: strip injected context blocks before ingesting; `everything`: ingest as-is |
| `minCaptureLength` | number | `10` | Skip captured text shorter than this character count |
| `debug` | boolean | `false` | Enable verbose diagnostics (response time, byte sizes, counts) |

#### Query Mode

`queryMode` is intentionally pinned to `naive` so all recall uses `POST /query/data` only (raw retrieval, no LLM answer generation path).

### Dependencies

- **LightRAG Server** – provides the memory backend, embedding model, and knowledge graph storage. Must be running and accessible at `baseUrl`.
- **OpenClaw Gateway 2026.1+** – plugin SDK compatibility.
- **Node.js 18+** (for plugin development only).

Ensure the LightRAG server is configured with a consistent embedding model across restarts; changing models requires re‑ingestion of all memories.

## Use Cases

### 1. Personal Assistant with Long‑Term Memory
**Scenario:** Daily personal assistant across multiple channels (Telegram, Discord, etc.) that remembers preferences, past decisions, and important facts across sessions.

**How it works:**
- Every conversation turn is automatically ingested into LightRAG.
- When you ask "What did we decide about the vacation last week?", the plugin recalls relevant snippets from memory and injects them into the AI's context.
- The assistant answers with precise references to past conversations.

**Configuration:** `autoIngest: true`, `autoRecall: true`, `maxRecallResults: 5`.

### 2. Team Collaboration Bot
**Scenario:** Shared OpenClaw instance serving a team channel (e.g., Slack) that needs to remember decisions, action items, and shared knowledge.

**How it works:**
- Ingests messages from all team members.
- Provides semantic search over past discussions ("Find the decision about the Q4 budget").
- Can be extended with custom metadata (e.g., tagging memories by project).

**Considerations:** Ensure LightRAG Server is accessible to all team members; set `captureMode: "everything"` to retain full context.

### 3. Debugging and Support Agent
**Scenario:** OpenClaw as a support agent that interacts with users to troubleshoot issues, recalling similar past issues and solutions.

**How it works:**
- Ingests support tickets and resolution notes.
- When a new issue is described, the plugin recalls similar past issues and suggests known fixes.
- Reduces repetitive work for human agents.

**Configuration:** `maxRecallResults: 10` to provide more context; `debug: true` during initial setup.

### Additional Use Cases
For more scenarios (content creation, compliance audit, multi‑channel context sharing, custom memory workflows), see [USE_CASES.md](USE_CASES.md).

## Known Issues & Limitations

### Technical Limitations & Dependencies

| Category | Limitation | Impact | Workaround |
|----------|------------|--------|------------|
| **Authentication** | API key stored in plaintext in `openclaw.json` | Security risk if config file leaked | Use environment variables, OpenClaw secret management (when available) |
| **Server availability** | No automatic retry or circuit‑breaker | Failed operations are dropped, memory gaps | Monitor LightRAG server health, implement external retry logic |
| **Performance** | Ingestion adds HTTP overhead per turn | Latency increase (~50‑200ms per turn) | Disable `autoIngest` for high‑volume channels |
| **Performance** | Recall adds network + embedding time | AI turn latency increased (~100‑500ms) | Reduce `maxRecallResults`, use localhost, disable `autoRecall` |
| **Scalability** | SQLite backend (default in LightRAG) | Limited concurrent writes, not for large teams | Use LightRAG PostgreSQL backend |
| **Schema changes** | LightRAG API may evolve between versions | Plugin may break after server upgrade | Pin versions, check compatibility before upgrading |
| **Security** | No encryption at rest | Sensitive conversations stored plaintext | Encrypt disk volume, use SQLite encryption extensions |
| **Memory management** | No automatic pruning (TTL) | Database grows indefinitely | Use LightRAG's cleanup tools, periodic manual cleanup |
| **Multi‑tenant isolation** | Single namespace for all memories | No separation between users/channels | Run separate LightRAG instances per tenant |
| **Inbox / feedback** | LightRAG has no inbox or feedback endpoints | `memory_inbox_*` and `memory_feedback` tools return empty stubs | Use LightRAG Web UI for document management |

### Performance Characteristics (Typical)

| Operation | Latency (localhost) | Throughput |
|-----------|---------------------|------------|
| Ingestion per message | 20‑100 ms | 10‑50 msg/sec (SQLite) |
| Recall query (top‑8, mode=naive) | 100‑600 ms | 3‑10 queries/sec |
| Embedding computation | 10‑50 ms per query | Depends on model & CPU |

> **Note:** This plugin now uses only `naive` mode to keep `/query/data` responses stable.

### Advanced Configuration & Workarounds

For detailed guidance on configuring capture parameters, custom hooks, and scaling strategies, see [USAGE.md](USAGE.md).

## Error Handling

Common error scenarios and how to diagnose them:

| Error | Likely Cause | Solution |
|-------|--------------|----------|
| `401 Unauthorized` | Invalid or missing API key | Verify `apiKey` in plugin config matches the LightRAG Server's configured key |
| `404 Not Found` | Wrong `baseUrl` or LightRAG Server not running | Check that `baseUrl` points to `http://<host>:9621` (LightRAG default port) |
| `Connection refused` | LightRAG Server not running | Start LightRAG Server and verify it listens on the expected port |
| `Memory search returns empty` | No documents ingested yet | Check that `autoIngest: true` and hooks are firing — enable `debug: true` to see ingestion logs |
| `Plugin fails to load` | Missing manifest, TypeScript errors, plugin ID mismatch | Check Gateway logs, verify `openclaw.plugin.json`, run `npx tsc --noEmit` |
| `High latency on AI turns` | Recall query adding round‑trip + embedding time | Reduce `maxRecallResults`, ensure LightRAG Server on localhost, set `queryMode: "naive"` for faster (but lower quality) recall |
| `Missing conversation context in recalled memories` | `captureMode` strips context | Set `captureMode: "everything"` to retain full conversation context |
| `LightRAG server crashes under load` | SQLite locking issues, memory limits | Monitor server resources, consider PostgreSQL backend |
| `Plugin config changes not applied` | Gateway not restarted after config changes | Restart Gateway with `openclaw gateway restart` |

## Testing

### Unit tests
Run the plugin's own test suite (if available):

```bash
cd memory-lightrag-local
npm test
```

### Integration tests
1. Start a local LightRAG Server.
2. Configure the plugin with `debug: true`.
3. Send a test message through OpenClaw and verify that ingestion and recall logs appear in the Gateway output — look for `[lightrag]` prefixed lines.

### Manual verification
- Use the LightRAG Web UI (`http://127.0.0.1:9621`) to browse ingested documents and query the knowledge graph.
- Query the LightRAG API directly:
  ```bash
  curl -X POST http://127.0.0.1:9621/query/data \
    -H "Content-Type: application/json" \
    -H "X-API-Key: your-api-key-here" \
    -d '{"query": "test query", "mode": "naive"}'
  ```
- Check server health:
  ```bash
  curl http://127.0.0.1:9621/health -H "X-API-Key: your-api-key-here"
  ```

### Pending Tests
The following tests are planned but not yet implemented:

#### Unit Tests
- `adapter-client.ts`: HTTP client error handling (network errors, 4xx/5xx responses).
- `config.ts`: Config schema parsing and default values.
- `hooks/capture.ts`: Capture logic for different `captureMode` settings.
- `hooks/recall.ts`: Recall injection and context formatting.
- `sanitize.ts`: Sensitive data stripping from captured text.

#### Integration Tests
- End‑to‑end test with a mock LightRAG Server.
- Plugin lifecycle (load, enable, disable, unload).
- Compatibility with OpenClaw Gateway 2026.1+.

## Roadmap & Missing Features

- [ ] **Bulk ingestion** of historical conversation logs.
- [ ] **Memory pruning** (automatic cleanup of old/low‑relevance memories).
- [ ] **Multi‑tenant support** (separate memory stores per user/channel).
- [ ] **Embedding customization** (allow choosing different embedding models per channel).
- [ ] **Prometheus metrics** for monitoring ingestion/recall rates and latency.

## Versioning

This plugin follows [Semantic Versioning](https://semver.org/). See `CHANGELOG.md` for release notes.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Write tests for your changes.
4. Submit a pull request with a clear description.

## License

MIT
