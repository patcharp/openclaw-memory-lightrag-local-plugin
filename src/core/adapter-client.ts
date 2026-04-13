/**
 * AdapterClient — speaks directly to the LightRAG Server REST API.
 *
 * LightRAG Server endpoints used:
 *   POST /query           → query / recall
 *   POST /documents/texts → batch ingest (capture)
 *   POST /documents/text  → single text ingest
 *   GET  /health          → health check
 *
 * NOTE: LightRAG has no concept of "inbox", "retrieval feedback", or per-doc
 * fetch by ID.  Those methods return graceful stubs so the calling code does
 * not throw.
 */

export type AdapterContextItem = { text: string; docId?: string };

export interface AdapterLogger {
  debug(msg: string): void;
  warn(msg: string): void;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Timing helper — returns elapsed ms since the mark. */
function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

/** Compact byte-length of a JSON-serialisable value. */
function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

/** Truncate a string for inline log display. */
function preview(text: string, maxLen = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

async function getJson(
  baseUrl: string,
  apiKey: string,
  path: string,
  logger?: AdapterLogger,
  label?: string,
) {
  const start = performance.now();
  const url = `${baseUrl}${path}`;

  logger?.debug(`[lightrag] → GET ${path}`);

  const res = await fetch(url, {
    method: "GET",
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(30000),
  });

  const ms = elapsedMs(start);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger?.warn(`[lightrag] ✗ GET ${path} status=${res.status} elapsed=${ms}ms body=${preview(text)}`);
    throw new Error(`request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  logger?.debug(
    `[lightrag] ✓ GET ${path}${label ? ` (${label})` : ""} status=${res.status} elapsed=${ms}ms responseBytes=${jsonBytes(data)}`,
  );
  return data;
}

async function postJson(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  logger?: AdapterLogger,
  label?: string,
) {
  const start = performance.now();
  const url = `${baseUrl}${path}`;
  const reqBytes = jsonBytes(body);

  logger?.debug(`[lightrag] → POST ${path}${label ? ` (${label})` : ""} requestBytes=${reqBytes}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const ms = elapsedMs(start);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger?.warn(
      `[lightrag] ✗ POST ${path} status=${res.status} elapsed=${ms}ms body=${preview(text)}`,
    );
    throw new Error(`request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  logger?.debug(
    `[lightrag] ✓ POST ${path}${label ? ` (${label})` : ""} status=${res.status} elapsed=${ms}ms responseBytes=${jsonBytes(data)}`,
  );
  return data;
}

// ── Query types (LightRAG /query/data request) ─────────────────────────────

type LightRagQueryMode = "local" | "global" | "hybrid" | "naive" | "mix" | "bypass";

interface LightRagQueryDataRequest {
  query: string;
  mode?: LightRagQueryMode;
  top_k?: number;
  chunk_top_k?: number;
  include_references?: boolean;
  hl_keywords?: string[];
  ll_keywords?: string[];
}

interface LightRagQueryDataEntity {
  entity_name: string;
  entity_type: string;
  description: string;
  source_id: string;
  file_path: string;
  reference_id: string;
}

interface LightRagQueryDataRelationship {
  src_id: string;
  tgt_id: string;
  description: string;
  keywords: string;
  weight: number;
  source_id: string;
  file_path: string;
  reference_id: string;
}

interface LightRagQueryDataChunk {
  content: string;
  file_path: string;
  chunk_id: string;
  reference_id: string;
}

interface LightRagQueryDataReference {
  reference_id: string;
  file_path: string;
}

interface LightRagQueryDataData {
  entities: LightRagQueryDataEntity[];
  relationships: LightRagQueryDataRelationship[];
  chunks: LightRagQueryDataChunk[];
  references: LightRagQueryDataReference[];
}

interface LightRagQueryDataMetadata {
  query_mode: string;
  keywords?: {
    high_level: string[];
    low_level: string[];
  };
  processing_info?: {
    total_entities_found: number;
    total_relations_found: number;
    entities_after_truncation: number;
    relations_after_truncation: number;
    final_chunks_count: number;
  };
}

interface LightRagQueryDataResponse {
  status: string;
  message: string;
  data: LightRagQueryDataData;
  metadata: LightRagQueryDataMetadata;
}

// ── Main client ────────────────────────────────────────────────────────────

export class AdapterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    /** LightRAG query mode – "mix" is recommended for best results */
    private readonly queryMode: LightRagQueryMode = "mix",
    /** Optional logger — only called when debug=true in plugin config */
    private readonly logger?: AdapterLogger,
  ) {}

  /**
   * Recall: query LightRAG for relevant context.
   * Maps to POST /query/data
   */
  async query(
    query: string,
    topK: number,
    opts?: { conversationId?: string; date?: string },
  ) {
    const body: LightRagQueryDataRequest = {
      query,
      mode: this.queryMode,
      top_k: topK,
      include_references: true,
    };

    this.logger?.debug(
      `[lightrag] query mode=${this.queryMode} topK=${topK} queryLen=${query.length} conv=${opts?.conversationId ?? "-"}`,
    );

    const result: LightRagQueryDataResponse = await postJson(
      this.baseUrl,
      this.apiKey,
      "/query/data",
      body,
      this.logger,
      `mode=${this.queryMode}`,
    );

    // Build context items from /query/data response: entities, relationships, chunks
    const contextItems: AdapterContextItem[] = [];

    // Parse entities
    if (Array.isArray(result.data?.entities)) {
      for (const entity of result.data.entities) {
        const text = entity.description || entity.entity_name || "";
        if (text) {
          contextItems.push({ text, docId: entity.file_path || entity.reference_id });
        }
      }
    }

    // Parse relationships
    if (Array.isArray(result.data?.relationships)) {
      for (const rel of result.data.relationships) {
        const text = rel.description || "";
        if (text) {
          contextItems.push({ text, docId: rel.file_path || rel.reference_id });
        }
      }
    }

    // Parse chunks
    if (Array.isArray(result.data?.chunks)) {
      for (const chunk of result.data.chunks) {
        const text = chunk.content || "";
        if (text) {
          contextItems.push({ text, docId: chunk.file_path || chunk.reference_id });
        }
      }
    }

    const refCount = Array.isArray(result.data?.references) ? result.data.references.length : 0;
    const entityCount = Array.isArray(result.data?.entities) ? result.data.entities.length : 0;
    const relCount = Array.isArray(result.data?.relationships) ? result.data.relationships.length : 0;
    const chunkCount = Array.isArray(result.data?.chunks) ? result.data.chunks.length : 0;

    this.logger?.debug(
      `[lightrag] query result status=${result.status} entities=${entityCount} relations=${relCount} chunks=${chunkCount} references=${refCount} contextItems=${contextItems.length}`,
    );

    return { raw: result, contextItems };
  }

  /**
   * Get a document by ID.
   * LightRAG has no per-doc fetch endpoint — return a stub.
   */
  async get(_docId: string) {
    this.logger?.debug(`[lightrag] get docId=${_docId} (stub — LightRAG has no per-doc endpoint)`);
    return { text: "" };
  }

  /**
   * Ingest conversation items into LightRAG.
   * Maps to POST /documents/texts (batch) or POST /documents/text (single).
   */
  async ingest(payload: {
    conversationId: string;
    channel: string;
    date: string;
    items: Array<{
      role?: string;
      content: string;
      ts?: string;
      sender?: string;
      messageId?: string;
    }>;
  }) {
    const texts = payload.items
      .filter((item) => item.content && item.content.trim().length > 0)
      .map((item) => {
        const parts: string[] = [];
        if (item.role) parts.push(`[${item.role.toUpperCase()}]`);
        if (item.sender) parts.push(`(${item.sender})`);
        if (item.ts) parts.push(`@${item.ts}`);
        parts.push(item.content.trim());
        return parts.join(" ");
      });

    if (texts.length === 0) {
      this.logger?.debug(`[lightrag] ingest skip — no content after filter`);
      return { status: "skipped", message: "no content" };
    }

    const totalChars = texts.reduce((n, t) => n + t.length, 0);
    const endpoint = texts.length === 1 ? "/documents/text" : "/documents/texts";

    this.logger?.debug(
      `[lightrag] ingest conv=${payload.conversationId} channel=${payload.channel} items=${texts.length} totalChars=${totalChars} endpoint=${endpoint}`,
    );

    const fileSources = texts.map(
      () => `conv:${payload.conversationId}/ch:${payload.channel}/date:${payload.date}`,
    );

    if (texts.length === 1) {
      return postJson(
        this.baseUrl,
        this.apiKey,
        "/documents/text",
        { text: texts[0], file_source: fileSources[0] },
        this.logger,
        `conv=${payload.conversationId}`,
      );
    }

    return postJson(
      this.baseUrl,
      this.apiKey,
      "/documents/texts",
      { texts, file_sources: fileSources },
      this.logger,
      `conv=${payload.conversationId} items=${texts.length}`,
    );
  }

  /**
   * List inbox items.
   * LightRAG has no inbox concept — return an empty stub so the tool does not
   * throw.
   */
  async listInbox(
    _params: {
      conversationId?: string;
      date?: string;
      status?: "pending" | "approved" | "merged" | "archived" | "all";
      limit?: number;
      offset?: number;
    } = {},
  ) {
    this.logger?.debug(`[lightrag] listInbox (stub — LightRAG has no inbox endpoint)`);
    return { items: [], total: 0, _note: "LightRAG has no inbox endpoint" };
  }

  /**
   * Apply an inbox action.
   * LightRAG has no inbox concept — return a stub.
   */
  async inboxAction(_payload: {
    itemId: number;
    action: "approve" | "merge" | "archive";
    mergeTargetId?: number;
    note?: string;
  }) {
    this.logger?.debug(`[lightrag] inboxAction (stub — LightRAG has no inbox endpoint)`);
    return { ok: false, _note: "LightRAG has no inbox endpoint" };
  }

  /**
   * Send retrieval feedback.
   * LightRAG has no feedback endpoint — return a stub.
   */
  async retrievalFeedback(_payload: {
    queryId: number;
    itemId?: string;
    helpful: boolean;
    comment?: string;
  }) {
    this.logger?.debug(`[lightrag] retrievalFeedback (stub — LightRAG has no feedback endpoint)`);
    return { ok: false, _note: "LightRAG has no feedback endpoint" };
  }

  /**
   * Health check — maps to GET /health.
   */
  async health() {
    return getJson(this.baseUrl, this.apiKey, "/health", this.logger, "health");
  }
}
