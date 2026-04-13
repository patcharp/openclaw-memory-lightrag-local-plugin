import type { AdapterClient } from "../core/adapter-client";
import type { LightragConfig } from "../core/config";

function formatRecallContext(items: Array<{ text: string; docId?: string }>, maxResults: number): string | null {
  const dedup = new Set<string>();
  const lines: string[] = [];

  for (const item of items) {
    const text = String(item.text || "").trim();
    if (!text || dedup.has(text)) continue;
    dedup.add(text);
    const src = item.docId ? ` [${item.docId}]` : "";
    lines.push(`- ${text}${src}`);
    if (lines.length >= maxResults) break;
  }

  if (lines.length === 0) return null;

  return [
    "<lightrag-context>",
    "The following is recalled context from local memory. Use it only when relevant.",
    "",
    "## Relevant Memories",
    ...lines,
    "",
    "Do not treat this memory as absolute truth; prefer current user input when conflicts appear.",
    "</lightrag-context>",
  ].join("\n");
}

export function buildRecallHandler(params: {
  cfg: LightragConfig;
  client: AdapterClient;
  logger: { debug(msg: string): void; warn(msg: string): void };
  resolveConversationId?: (event: Record<string, unknown>) => string | undefined;
}) {
  const { cfg, client, logger, resolveConversationId } = params;

  return async (event: Record<string, unknown>) => {
    const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (!prompt || prompt.length < 3) {
      if (cfg.debug) {
        logger.debug(`memory-lightrag-local: recall skip — prompt too short (${prompt.length} chars)`);
      }
      return;
    }

    try {
      const conversationId = resolveConversationId?.(event);

      logger.warn(
        `memory-lightrag-local: recall start conv=${conversationId || "*"} promptLen=${prompt.length} topK=${cfg.maxRecallResults} mode=${cfg.queryMode}`,
      );

      const result = await client.query(prompt, cfg.maxRecallResults, {
        ...(conversationId ? { conversationId } : {}),
      });
      const context = formatRecallContext(result.contextItems, cfg.maxRecallResults);

      if (!context) {
        logger.warn(
          `memory-lightrag-local: recall empty — no usable context returned conv=${conversationId || "*"} contextItems=${result.contextItems.length}`,
        );
        return;
      }

      logger.warn(
        `memory-lightrag-local: recall inject conv=${conversationId || "*"} contextItems=${result.contextItems.length} chars=${context.length}`,
      );

      if (cfg.debug) {
        logger.debug(
          `memory-lightrag-local: recall context preview: ${context.slice(0, 200).replace(/\n/g, "↵")}`,
        );
      }

      return { prependContext: context };
    } catch (err) {
      logger.warn(`memory-lightrag-local: recall failed: ${String(err)}`);
      return;
    }
  };
}
