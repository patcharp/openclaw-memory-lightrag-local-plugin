import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { AdapterClient } from "./core/adapter-client";
import { lightragConfigSchema, parseConfig } from "./core/config";
import { createPluginLogger } from "./core/logger";
import { buildCaptureHandler } from "./hooks/capture";
import { buildRecallHandler } from "./hooks/recall";
import {
  channelBase,
  extractText,
  extractUntrustedMetadata,
  normalizeConversationId,
  resolveConversationId,
} from "./core/sanitize";

const MemorySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "number" },
    minScore: { type: "number" },
  },
  required: ["query"],
};

const MemoryGetSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    from: { type: "number" },
    lines: { type: "number" },
  },
  required: ["path"],
};

const MemoryInboxListSchema = {
  type: "object",
  properties: {
    conversationId: { type: "string" },
    date: { type: "string" },
    status: { type: "string", enum: ["pending", "approved", "merged", "archived", "all"] },
    limit: { type: "number" },
    offset: { type: "number" },
  },
};

const MemoryInboxActionSchema = {
  type: "object",
  properties: {
    itemId: { type: "number" },
    action: { type: "string", enum: ["approve", "merge", "archive"] },
    mergeTargetId: { type: "number" },
    note: { type: "string" },
  },
  required: ["itemId", "action"],
};

const MemoryRetrievalFeedbackSchema = {
  type: "object",
  properties: {
    queryId: { type: "number" },
    itemId: { type: "string" },
    helpful: { type: "boolean" },
    comment: { type: "string" },
  },
  required: ["queryId", "helpful"],
};

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

const memoryPlugin = {
  id: "memory-lightrag-local",
  name: "Memory (LightRAG Local)",
  description: "Memory tools backed by local LightRAG adapter",
  kind: "memory" as const,
  configSchema: lightragConfigSchema,

  register(api: OpenClawPluginApi) {
    let cfg;
    const pluginLogger = createPluginLogger(api.logger, {
      prefix: "memory-lightrag-local",
      debugEnabled: false,
    });
    try {
      cfg = parseConfig(api.pluginConfig);
    } catch (err) {
      pluginLogger.event("config_invalid", { error: String(err) }, "warn");
      return;
    }

    const logger = createPluginLogger(api.logger, {
      prefix: "memory-lightrag-local",
      debugEnabled: cfg.debug,
    });
    const recallLogger = logger.child("recall");
    const captureLogger = logger.child("capture");
    const inboundLogger = logger.child("inbound");
    const client = new AdapterClient(cfg.baseUrl, cfg.apiKey, cfg.queryMode, logger.child("lightrag"));
    const lastConversationByChannel = new Map<string, string>();

    logger.event(
      "register",
      {
        autoIngest: cfg.autoIngest,
        autoRecall: cfg.autoRecall,
        captureMode: cfg.captureMode,
        queryMode: cfg.queryMode,
      },
      "info",
    );

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description: "Mandatory recall step: searches local LightRAG adapter for relevant context.",
        parameters: MemorySearchSchema,
        async execute(_toolCallId: string, params: unknown) {
          const { query, maxResults = 5 } = params as { query: string; maxResults?: number };
          try {
            const result = await client.query(query, maxResults);
            const results = result.contextItems.map((item, idx) => ({
              id: `${item.docId || "doc"}-${idx}`,
              path: `adapter:${item.docId || "unknown"}`,
              startLine: 1,
              endLine: 1,
              score: 1,
              snippet: item.text,
              source: "adapter",
            }));

            // Render tool results as plain text to avoid "[Object Object]" output.
            const resultsText = results.map((r, i) => {
              const snippetText = typeof r.snippet === 'string' ? r.snippet : JSON.stringify(r.snippet);
              return `[${i + 1}] ${snippetText}\n    Source: ${r.source} | Path: ${r.path} | Score: ${r.score}`;
            }).join('\n');
            
            const outputText = resultsText 
              ? `Found ${results.length} result(s):\n${resultsText}`
              : 'No results found.';
            
            return {
              content: [{ type: "text", text: outputText }],
              details: { results, provider: "lightrag-local" },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ results: [], disabled: true, error: err instanceof Error ? err.message : String(err) }, null, 2),
                },
              ],
            };
          }
        },
      },
      { name: "memory_search" },
    );

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description: "Fetch full text for a memory doc from LightRAG adapter.",
        parameters: MemoryGetSchema,
        async execute(_toolCallId: string, params: unknown) {
          const { path } = params as { path: string };
          const docId = path.startsWith("adapter:") ? path.slice("adapter:".length) : path;
          try {
            const result = await client.get(docId);
            return {
              content: [{ type: "text", text: JSON.stringify({ path, text: result.text }, null, 2) }],
              details: { path, text: result.text },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ path, text: "", disabled: true, error: err instanceof Error ? err.message : String(err) }, null, 2),
                },
              ],
            };
          }
        },
      },
      { name: "memory_get" },
    );

    api.registerTool(
      {
        name: "memory_inbox_list",
        label: "Memory Inbox List",
        description: "List memory inbox review items from LightRAG adapter.",
        parameters: MemoryInboxListSchema,
        async execute(_toolCallId: string, params: unknown) {
          try {
            const result = await client.listInbox((params || {}) as Record<string, unknown> as {
              conversationId?: string;
              date?: string;
              status?: "pending" | "approved" | "merged" | "archived" | "all";
              limit?: number;
              offset?: number;
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              details: result,
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ items: [], disabled: true, error: err instanceof Error ? err.message : String(err) }, null, 2),
                },
              ],
            };
          }
        },
      },
      { name: "memory_inbox_list" },
    );

    api.registerTool(
      {
        name: "memory_inbox_action",
        label: "Memory Inbox Action",
        description: "Apply review action (approve/merge/archive) to a memory inbox item.",
        parameters: MemoryInboxActionSchema,
        async execute(_toolCallId: string, params: unknown) {
          try {
            const payload = params as {
              itemId: number;
              action: "approve" | "merge" | "archive";
              mergeTargetId?: number;
              note?: string;
            };
            const result = await client.inboxAction(payload);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              details: result,
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2),
                },
              ],
            };
          }
        },
      },
      { name: "memory_inbox_action" },
    );

    api.registerTool(
      {
        name: "memory_feedback",
        label: "Memory Retrieval Feedback",
        description: "Send helpful/not-helpful feedback for retrieval results.",
        parameters: MemoryRetrievalFeedbackSchema,
        async execute(_toolCallId: string, params: unknown) {
          try {
            const payload = params as { queryId: number; itemId?: string; helpful: boolean; comment?: string };
            const result = await client.retrievalFeedback(payload);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              details: result,
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2),
                },
              ],
            };
          }
        },
      },
      { name: "memory_feedback" },
    );

    if (cfg.autoRecall) {
      api.on(
        "before_agent_start",
        buildRecallHandler({
          cfg,
          client,
          logger: recallLogger,
          resolveConversationId: (event: Record<string, unknown>) => {
            const direct =
              (typeof event.conversationId === "string" && event.conversationId) ||
              (typeof event.channelConversationId === "string" && event.channelConversationId) ||
              undefined;
            if (direct) {
              const channel = channelBase(String(direct).split(":")[0] || "unknown");
              return normalizeConversationId(channel, direct);
            }

            const provider = channelBase(String(event.channelId || "unknown"));
            return lastConversationByChannel.get(provider);
          },
        }),
      );
    }

    if (!cfg.autoIngest) return;

    api.on("message_received", async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      try {
        inboundLogger.event("message_received", {
          success: event.success,
          contentType: typeof event.content,
        });

        const channel = channelBase(String(ctx?.channelId || "unknown"));
        const rawText = extractText(event.content);
        const untrusted = extractUntrustedMetadata(rawText);
        const fallbackFrom = firstString(event.from, untrusted.senderId);
        const conversationId = resolveConversationId(ctx || {}, fallbackFrom);
        const canonical = normalizeConversationId(channel, conversationId);
        lastConversationByChannel.set(channel, canonical);

        const metadata = (event.metadata && typeof event.metadata === "object")
          ? (event.metadata as Record<string, unknown>)
          : {};
        const messageId = firstString(metadata.messageId, metadata.message_id, untrusted.messageId);
        inboundLogger.event("message_received_context_updated", {
          conversationId: canonical,
          senderId: untrusted.senderId || "-",
          messageId: messageId || "-",
        });
      } catch (err) {
        inboundLogger.event("message_received_failed", { error: String(err) }, "warn");
      }
    });

    // Legacy mode removed: no message_sent hook. agent_end is the single source of truth.
    api.on(
      "agent_end",
      buildCaptureHandler({
        logger: captureLogger,
        cfg,
        client,
        lastConversationByChannel,
      }),
    );
  },
};

export default memoryPlugin;
