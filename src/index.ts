import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { AdapterClient } from "./core/adapter-client";
import { lightragConfigSchema, parseConfig } from "./core/config";
import { buildCaptureHandler } from "./hooks/capture";
import { buildRecallHandler } from "./hooks/recall";
import {
  channelBase,
  extractText,
  normalizeConversationId,
  normalizeTimestamp,
  resolveConversationId,
  sanitizeCapturedText,
  toDateString,
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

const memoryPlugin = {
  id: "memory-lightrag-local",
  name: "Memory (LightRAG Local)",
  description: "Memory tools backed by local LightRAG adapter",
  kind: "memory" as const,
  configSchema: lightragConfigSchema,

  register(api: OpenClawPluginApi) {
    let cfg;
    try {
      cfg = parseConfig(api.pluginConfig);
    } catch (err) {
      api.logger.warn(`memory-lightrag-local: invalid config; plugin disabled: ${String(err)}`);
      return;
    }

    const client = new AdapterClient(cfg.baseUrl, cfg.apiKey, cfg.queryMode, cfg.debug ? api.logger : undefined);
    const lastConversationByChannel = new Map<string, string>();

    api.logger.warn(
      `memory-lightrag-local: register autoIngest=${cfg.autoIngest} autoRecall=${cfg.autoRecall} captureMode=${cfg.captureMode}`,
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

            return {
              content: [{ type: "text", text: JSON.stringify({ results, provider: "lightrag-local" }, null, 2) }],
              details: { results },
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
          logger: api.logger,
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
        const channel = channelBase(String(ctx?.channelId || "unknown"));
        const fallbackFrom = typeof event.from === 'string' ? event.from : undefined;
        const conversationId = resolveConversationId(ctx || {}, fallbackFrom);
        const canonical = normalizeConversationId(channel, conversationId);
        lastConversationByChannel.set(channel, canonical);

        const text = sanitizeCapturedText(extractText(event.content), cfg.captureMode);
        if (!text || text.length < cfg.minCaptureLength) return;

        await client.ingest({
          conversationId: canonical,
          channel,
          date: toDateString(typeof event.timestamp === 'number' ? normalizeTimestamp(event.timestamp) : undefined),
          items: [
            {
              role: "user",
              content: text,
              ts: typeof event.timestamp === 'number' ? new Date(normalizeTimestamp(event.timestamp)).toISOString() : undefined,
              sender: fallbackFrom,
              messageId: (event.metadata && typeof event.metadata === 'object' && event.metadata !== null && 'messageId' in event.metadata && typeof event.metadata.messageId === 'string') ? event.metadata.messageId : undefined,
            },
          ],
        });

        if (cfg.debug) {
          api.logger.debug(`memory-lightrag-local: inbound ingest ok conv=${canonical}`);
        }
      } catch (err) {
        api.logger.warn(`memory-lightrag-local: message_received failed: ${String(err)}`);
      }
    });

    // Legacy mode removed: no message_sent hook. agent_end is the single source of truth.
    api.on(
      "agent_end",
      buildCaptureHandler({
        api,
        cfg,
        client,
        lastConversationByChannel,
      }),
    );
  },
};

export default memoryPlugin;
