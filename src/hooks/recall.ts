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
  logger: { debug(msg: string): void; info?: (msg: string) => void; warn(msg: string): void };
  resolveConversationId?: (event: Record<string, unknown>) => string | undefined;
}) {
  const { cfg, client, logger, resolveConversationId } = params;

  return async (event: Record<string, unknown>) => {
    let prompt = "";

    // 1. Try extracting exact last user message if provided
    if (Array.isArray(event.messages) && event.messages.length > 0) {
      const lastUserMsg = [...event.messages].reverse().find((m: any) => String(m?.role || "").toLowerCase() === "user");
      if (lastUserMsg) {
        prompt = String(lastUserMsg.content || lastUserMsg.text || "");
      }
    }

    // 2. Fallback to event.prompt
    if (!prompt) {
      prompt = typeof event.prompt === "string" ? event.prompt : "";
      
      // Remove OpenClaw injected metadata blocks
      const metaStart = prompt.indexOf("Conversation info (untrusted metadata):");
      if (metaStart !== -1) {
        const blockEnd = prompt.indexOf("```", metaStart + 40);
        if (blockEnd !== -1) {
          prompt = prompt.slice(0, metaStart) + prompt.slice(blockEnd + 3);
        } else {
          prompt = prompt.slice(0, metaStart);
        }
      }
    }

    // Clean up and truncate huge prompts
    prompt = prompt.trim();
    if (prompt.length > 800) {
      // User's actual question is usually at the end
      prompt = prompt.slice(-800).trim();
    }
    if (!prompt || prompt.length < 3) {
      if (cfg.debug) {
        logger.info?.(`memory-lightrag-local: recall skip — prompt too short (${prompt.length} chars)`);
      }
      return;
    }

    const recallStart = performance.now();
    const queryPreview = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;

    try {
      const conversationId = resolveConversationId?.(event);

      logger.info?.(
        `memory-lightrag-local: recall start conv=${conversationId || "*"} topK=${cfg.maxRecallResults} mode=${cfg.queryMode} query="${queryPreview}"`,
      );

      const result = await client.query(prompt, cfg.maxRecallResults, {
        ...(conversationId ? { conversationId } : {}),
      });

      const elapsedMs = Math.round(performance.now() - recallStart);
      const context = formatRecallContext(result.contextItems, cfg.maxRecallResults);

      if (!context) {
        logger.info?.(
          `memory-lightrag-local: recall empty conv=${conversationId || "*"} contextItems=${result.contextItems.length} elapsed=${elapsedMs}ms`,
        );
        return;
      }

      // Snippet: first line of the actual recalled text (skip the XML wrapper lines)
      const firstMemoryLine = context
        .split("\n")
        .find((l) => l.startsWith("- "))
        ?.slice(2, 122) ?? "";
      const snippet = firstMemoryLine.length > 0 ? `"${firstMemoryLine}${firstMemoryLine.length >= 120 ? "…" : ""}"` : "(none)";

      logger.info?.(
        `memory-lightrag-local: recall inject conv=${conversationId || "*"} contextItems=${result.contextItems.length} chars=${context.length} elapsed=${elapsedMs}ms firstSnippet=${snippet}`,
      );

      // Debug mode: แสดง context preview เป็น text (ไม่ print object)
      if (cfg.debug) {
        const previewText = context.slice(0, 500).replace(/\n/g, " ");
        logger.info?.(`memory-lightrag-local: recall context preview: ${previewText}`);
      }

      return { prependContext: context };
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - recallStart);
      logger.warn(`memory-lightrag-local: recall failed elapsed=${elapsedMs}ms error=${String(err)}`);
      return;
    }
  };
}
