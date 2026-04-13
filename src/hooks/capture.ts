import type { AdapterClient } from "../core/adapter-client";
import type { LightragConfig } from "../core/config";
import type { PluginLogger } from "../core/logger";
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
  logger: PluginLogger;
  cfg: LightragConfig;
  client: AdapterClient;
  lastConversationByChannel: Map<string, string>;
}) {
  const { logger, cfg, client, lastConversationByChannel } = params;
  const lastAssistantSigByConversation = new Map<string, string>();

  return async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    logger.event("capture_event", {
      success: event.success,
      messages: Array.isArray(event.messages) ? event.messages.length : "none",
      ctx: ctx || {},
    });

    if (!event.success || !Array.isArray(event.messages) || event.messages.length === 0) {
      logger.event("capture_skip_invalid_event", {
        success: event.success,
        messages: Array.isArray(event.messages) ? event.messages.length : "none",
      });
      return;
    }

    const provider = channelBase(String(ctx?.messageProvider || ctx?.channelId || "unknown"));
    const canonicalConversation =
      lastConversationByChannel.get(provider) || `${provider}:unknown`;
    const conversationId = normalizeConversationId(provider, canonicalConversation);

    logger.event("capture_conversation_resolved", { conversationId, provider });

    const lastTurn = getLastTurn(event.messages);
    const texts = extractTurnTexts(lastTurn, cfg.captureMode)
      .map((t) => ({ ...t, text: clipText(t.text) }))
      .filter((t) => t.text.length >= cfg.minCaptureLength);

    if (texts.length === 0) {
      logger.event("capture_skip_no_eligible_text", {
        conversationId,
        provider,
        captureMode: cfg.captureMode,
        minCaptureLength: cfg.minCaptureLength,
      });
      return;
    }

    logger.event("capture_extracted", {
      conversationId,
      provider,
      items: texts.length,
      roles: texts.map((t) => t.role).join(","),
    });

    const assistant = [...texts].reverse().find((x) => x.role === "assistant");
    if (!assistant) {
      logger.event("capture_skip_no_assistant", {
        conversationId,
        roles: texts.map((t) => t.role).join(","),
      });
      return;
    }

    const sig = `${conversationId}|assistant|${assistant.text}`;
    if (lastAssistantSigByConversation.get(conversationId) === sig) {
      logger.event("capture_dedupe_skip", { conversationId });
      return;
    }
    lastAssistantSigByConversation.set(conversationId, sig);

    try {
      const captureStart = performance.now();
      const ingestResult = await client.ingest({
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
      const ingestStatus = String(ingestResult.status || "unknown").toLowerCase();

      if (ingestStatus === "duplicated") {
        logger.event("capture_duplicate", {
          conversationId,
          provider,
          items: texts.length,
          message: ingestResult.message || "-",
        });
        return;
      }

      logger.event(
        "capture_ok",
        { conversationId, provider, items: texts.length, roles, totalChars, elapsedMs, status: ingestStatus },
        "info",
      );
    } catch (err) {
      logger.event("capture_failed", { error: String(err) }, "warn");
    }
  };
}
