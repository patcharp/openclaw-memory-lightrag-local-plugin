import type { PluginLogger } from "./logger";

/**
 * AdapterClient — speaks directly to the LightRAG Server REST API.
 *
 * LightRAG Server endpoints used:
 *   POST /query/data      → query / recall
 *   POST /documents/texts → batch ingest (capture)
 *   POST /documents/text  → single text ingest
 *   GET  /health          → health check
 *
 * NOTE: LightRAG has no concept of "inbox", "retrieval feedback", or per-doc
 * fetch by ID.  Those methods return graceful stubs so the calling code does
 * not throw.
 */

export type AdapterContextItem = { text: string; docId?: string };
export type AdapterIngestResult = {
  status: string;
  message?: string;
  track_id?: string;
};

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

/** Sanitize dynamic ids for use in LightRAG file_source segments. */
function sourceToken(value: string, maxLen = 120): string {
  return value
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9:_./-]/g, "_")
    .slice(0, maxLen);
}

function toIngestResult(data: unknown): AdapterIngestResult {
  if (!data || typeof data !== "object") {
    return { status: "unknown", message: "unexpected non-object response from LightRAG ingest API" };
  }

  const rec = data as Record<string, unknown>;
  const status = typeof rec.status === "string" ? rec.status : "unknown";
  const message = typeof rec.message === "string" ? rec.message : undefined;
  const trackId = typeof rec.track_id === "string" ? rec.track_id : undefined;
  return { status, message, track_id: trackId };
}

async function getJson(
  baseUrl: string,
  apiKey: string,
  path: string,
  logger: PluginLogger,
  label?: string,
) {
  const start = performance.now();
  const url = `${baseUrl}${path}`;

  logger.event("http_request_start", { method: "GET", path, label });

  const res = await fetch(url, {
    method: "GET",
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(30000),
  });

  const ms = elapsedMs(start);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.event(
      "http_request_failed",
      { method: "GET", path, label, status: res.status, elapsedMs: ms, bodyPreview: preview(text) },
      "warn",
    );
    throw new Error(`request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  logger.event("http_request_ok", {
    method: "GET",
    path,
    label,
    status: res.status,
    elapsedMs: ms,
    responseBytes: jsonBytes(data),
  });
  return data;
}

async function postJson(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  logger: PluginLogger,
  label?: string,
) {
  const start = performance.now();
  const url = `${baseUrl}${path}`;
  const reqBytes = jsonBytes(body);

  logger.event("http_request_start", { method: "POST", path, label, requestBytes: reqBytes });

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
    logger.event(
      "http_request_failed",
      { method: "POST", path, label, status: res.status, elapsedMs: ms, bodyPreview: preview(text) },
      "warn",
    );
    throw new Error(`request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  logger.event("http_request_ok", {
    method: "POST",
    path,
    label,
    status: res.status,
    elapsedMs: ms,
    responseBytes: jsonBytes(data),
  });
  return data;
}

// ── Query types (LightRAG /query/data request) ─────────────────────────────

type LightRagQueryMode = "local" | "global" | "hybrid" | "naive" | "mix" | "bypass";

interface LightRagQueryDataRequest {
  query: string;
  mode?: LightRagQueryMode;
  include_references?: boolean;
  top_k?: number;
  enable_rerank?: boolean;
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
    /** Kept for compatibility; runtime request mode is forced to 'naive'. */
    private readonly configuredQueryMode: LightRagQueryMode = "naive",
    private readonly logger: PluginLogger,
  ) { }

  /**
   * Recall: query LightRAG for relevant context.
   * Maps to POST /query/data
   */
  async query(
    query: string,
    topK: number,
    opts?: { conversationId?: string; date?: string },
  ) {
    const requestMode: LightRagQueryMode = "naive";
    const safeQuery = String(query || "").trim();
    const safeTopK = Number.isFinite(topK) ? Math.max(1, Math.min(20, Math.floor(topK))) : 8;
    const body: LightRagQueryDataRequest = {
      query: safeQuery,
      mode: requestMode,
      include_references: true,
      enable_rerank: false,
      top_k: safeTopK,
    };

    this.logger.event("query_start", {
      configuredMode: this.configuredQueryMode,
      mode: requestMode,
      topK: safeTopK,
      queryLen: safeQuery.length,
      conversationId: opts?.conversationId || "-",
    });

    const result: LightRagQueryDataResponse = await postJson(
      this.baseUrl,
      this.apiKey,
      "/query/data",
      body,
      this.logger,
      `mode=${requestMode}`,
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

    this.logger.event("query_result", {
      status: result.status,
      entities: entityCount,
      relations: relCount,
      chunks: chunkCount,
      references: refCount,
      contextItems: contextItems.length,
    });

    return { raw: result, contextItems };
  }

  /**
   * Get a document by ID.
   * LightRAG has no per-doc fetch endpoint — return a stub.
   */
  async get(_docId: string) {
    this.logger.event("doc_get_stub", { docId: _docId });
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
  }): Promise<AdapterIngestResult> {
    const baseSource = `conv:${sourceToken(payload.conversationId)}/ch:${sourceToken(payload.channel)}/date:${sourceToken(payload.date)}`;
    const docs = payload.items
      .filter((item) => item.content && item.content.trim().length > 0)
      .map((item, idx) => {
        const parts: string[] = [];
        if (item.role) parts.push(`[${item.role.toUpperCase()}]`);
        if (item.sender) parts.push(`(${item.sender})`);
        if (item.ts) parts.push(`@${item.ts}`);
        parts.push(item.content.trim());
        const text = parts.join(" ");

        const perItemKey = item.messageId
          ? `msg:${sourceToken(item.messageId)}`
          : item.ts
            ? `ts:${sourceToken(item.ts)}`
            : "msg:unknown";
        const fileSource = `${baseSource}/${perItemKey}/i:${idx + 1}`;

        return { text, fileSource };
      });

    if (docs.length === 0) {
      this.logger.event("ingest_skip_no_content");
      return { status: "skipped", message: "no content" };
    }

    const texts = docs.map((d) => d.text);
    const fileSources = docs.map((d) => d.fileSource);
    const totalChars = texts.reduce((n, t) => n + t.length, 0);
    const endpoint = texts.length === 1 ? "/documents/text" : "/documents/texts";

    this.logger.event("ingest_start", {
      conversationId: payload.conversationId,
      channel: payload.channel,
      items: texts.length,
      totalChars,
      endpoint,
    });

    if (texts.length === 1) {
      const result = toIngestResult(
        await postJson(
          this.baseUrl,
          this.apiKey,
          "/documents/text",
          { text: texts[0], file_source: fileSources[0] },
          this.logger,
          `conv=${payload.conversationId}`,
        ),
      );
      if (result.status === "failure" || result.status === "fail") {
        throw new Error(`ingest failed: ${result.message || "unknown failure"}`);
      }
      return result;
    }

    const result = toIngestResult(
      await postJson(
        this.baseUrl,
        this.apiKey,
        "/documents/texts",
        { texts, file_sources: fileSources },
        this.logger,
        `conv=${payload.conversationId} items=${texts.length}`,
      ),
    );
    if (result.status === "failure" || result.status === "fail") {
      throw new Error(`ingest failed: ${result.message || "unknown failure"}`);
    }
    return result;
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
    this.logger.event("list_inbox_stub");
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
    this.logger.event("inbox_action_stub");
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
    this.logger.event("retrieval_feedback_stub");
    return { ok: false, _note: "LightRAG has no feedback endpoint" };
  }

  /**
   * Health check — maps to GET /health.
   */
  async health() {
    return getJson(this.baseUrl, this.apiKey, "/health", this.logger, "health");
  }
}
