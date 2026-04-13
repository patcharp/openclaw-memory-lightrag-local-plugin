import type { AdapterClient } from "../core/adapter-client";
import type { LightragConfig } from "../core/config";
import {
  channelBase,
  clipText,
  extractText,
  normalizeConversationId,
  sanitizeCapturedText,
  toDateString,
} from "../core/sanitize";

type MessageLike = {
  role?: string;
  content?: unknown;
  text?: string;
  output_text?: string;
  output?: unknown;
};

function getLastTurn(messages: unknown[]): unknown[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string };
    if (String(msg?.role || "").toLowerCase() === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
}

function extractTurnTexts(lastTurn: unknown[], captureMode: "all" | "everything"): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (const msg of lastTurn) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as MessageLike;
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;

    const raw = extractText(m.content ?? m.text ?? m.output_text ?? m.output ?? "");
    const text = sanitizeCapturedText(raw, captureMode);
    if (!text) continue;

    out.push({ role: role as "user" | "assistant", text });
  }

  return out;
}

export function buildCaptureHandler(params: {
  api: { logger: { debug(msg: string): void; info?: (msg: string) => void; warn(msg: string): void } };
  cfg: LightragConfig;
  client: AdapterClient;
  lastConversationByChannel: Map<string, string>;
}) {
  const { api, cfg, client, lastConversationByChannel } = params;
  const lastAssistantSigByConversation = new Map<string, string>();

  return async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    // Log event entry for debugging
    if (cfg.debug) {
      api.logger.info?.(
        `memory-lightrag-local: capture event success=${event.success} messages=${Array.isArray(event.messages) ? event.messages.length : "none"} ctx=${JSON.stringify(ctx || {})}`,
      );
    }

    if (!event.success || !Array.isArray(event.messages) || event.messages.length === 0) {
      api.logger.info?.(
        `memory-lightrag-local: capture skip (invalid/empty event) success=${event.success} messages=${Array.isArray(event.messages) ? event.messages.length : "none"}`,
      );
      return;
    }

    const provider = channelBase(String(ctx?.messageProvider || ctx?.channelId || "unknown"));
    const canonicalConversation =
      lastConversationByChannel.get(provider) || `${provider}:unknown`;
    const conversationId = normalizeConversationId(provider, canonicalConversation);

    if (cfg.debug) {
      api.logger.info?.(
        `memory-lightrag-local: capture conv=${conversationId} provider=${provider}`,
      );
    }

    const lastTurn = getLastTurn(event.messages);
    const texts = extractTurnTexts(lastTurn, cfg.captureMode)
      .map((t) => ({ ...t, text: clipText(t.text) }))
      .filter((t) => t.text.length >= cfg.minCaptureLength);

    if (texts.length === 0) {
      api.logger.info?.(
        `memory-lightrag-local: capture skip (no eligible text) conv=${conversationId} provider=${provider} mode=${cfg.captureMode} minLen=${cfg.minCaptureLength}`,
      );
      return;
    }

    if (cfg.debug) {
      api.logger.info?.(
        `memory-lightrag-local: capture extracted=${texts.length} roles=${texts.map((t) => t.role).join(",")}`,
      );
    }

    const assistant = [...texts].reverse().find((x) => x.role === "assistant");
    if (!assistant) {
      api.logger.info?.(
        `memory-lightrag-local: capture skip (no assistant output in last turn) conv=${conversationId} found=${texts.map((t) => t.role).join(",")}`,
      );
      return;
    }

    const sig = `${conversationId}|assistant|${assistant.text}`;
    if (lastAssistantSigByConversation.get(conversationId) === sig) {
      if (cfg.debug) {
        api.logger.info?.(`memory-lightrag-local: capture dedupe skip conv=${conversationId}`);
      }
      return;
    }
    lastAssistantSigByConversation.set(conversationId, sig);

    try {
      const captureStart = performance.now();
      await client.ingest({
        conversationId,
        channel: provider,
        date: toDateString(),
        items: texts.map((t) => ({
          role: t.role,
          content: t.text,
          ts: new Date().toISOString(),
          sender: t.role === "assistant" ? "assistant" : undefined,
        })),
      });

      const elapsedMs = Math.round(performance.now() - captureStart);
      const totalChars = texts.reduce((n, t) => n + t.text.length, 0);
      const roles = texts.map((t) => t.role).join(",");
      api.logger.info?.(
        `memory-lightrag-local: capture ok conv=${conversationId} provider=${provider} items=${texts.length} roles=${roles} totalChars=${totalChars} elapsed=${elapsedMs}ms`,
      );
    } catch (err) {
      api.logger.warn(`memory-lightrag-local: capture failed: ${String(err)}`);
    }
  };
}
