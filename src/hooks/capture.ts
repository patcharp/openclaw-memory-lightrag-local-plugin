import type { AdapterClient } from "../core/adapter-client";
import type { LightragConfig } from "../core/config";
import type { PluginLogger } from "../core/logger";
import {
  channelBase,
  clipText,
  extractText,
  extractUntrustedMetadata,
  normalizeConversationId,
  normalizeTimestamp,
  sanitizeCapturedText,
  toDateString,
} from "../core/sanitize";

type EventContext = Partial<{
  runId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
  messageProvider: string;
  trigger: string;
  channelId: string;
  accountId: string;
  conversationId: string;
}>;

type MessageLike = {
  role?: string;
  content?: unknown;
  text?: string;
  summary?: string;
  output_text?: string;
  output?: unknown;
  sender?: string;
  from?: string;
  name?: string;
  ts?: unknown;
  timestamp?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  date?: unknown;
  messageId?: string;
  message_id?: string;
  responseId?: string;
  id?: string;
  metadata?: unknown;
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

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(normalizeTimestamp(value)).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function conversationIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const raw = String(sessionKey).trim();
  if (!raw) return undefined;

  const parts = raw.split(":").filter(Boolean);
  const directIdx = parts.lastIndexOf("direct");
  if (directIdx >= 0 && directIdx < parts.length - 1) {
    return parts[directIdx + 1];
  }

  const tail = parts[parts.length - 1];
  if (!tail) return undefined;
  if (/^(agent|main|direct)$/i.test(tail)) return undefined;
  if (/^[a-z0-9_-]{3,}$/i.test(tail)) return tail;
  return undefined;
}

type TurnText = {
  role: "user" | "assistant";
  text: string;
  sender?: string;
  ts?: string;
  messageId?: string;
  senderId?: string;
};

function extractTurnTexts(lastTurn: unknown[], captureMode: "all" | "everything"): TurnText[] {
  const out: TurnText[] = [];

  for (const msg of lastTurn) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as MessageLike;
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;

    const raw = extractText(m.content ?? m.text ?? m.output_text ?? m.output ?? "");
    const untrusted = extractUntrustedMetadata(raw);
    const text = sanitizeCapturedText(raw, captureMode);
    if (!text) continue;

    const metadata = (m.metadata && typeof m.metadata === "object")
      ? (m.metadata as Record<string, unknown>)
      : {};
    const sender = firstString(
      m.sender,
      m.name,
      m.from,
      metadata.sender,
      metadata.display_name,
      untrusted.sender,
    );
    const ts = toIsoTimestamp(
      m.ts ??
      m.timestamp ??
      m.created_at ??
      m.createdAt ??
      m.date ??
      metadata.ts ??
      metadata.timestamp ??
      untrusted.timestamp,
    );
    const messageId = firstString(
      m.messageId,
      m.message_id,
      m.responseId,
      m.id,
      metadata.messageId,
      metadata.message_id,
      untrusted.messageId,
    );
    const senderId = firstString(metadata.sender_id, metadata.senderId, untrusted.senderId);

    out.push({ role: role as "user" | "assistant", text, sender, ts, messageId, senderId });
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

  return async (event: Record<string, unknown>, ctx?: EventContext) => {
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

    const lastTurn = getLastTurn(event.messages);
    const extracted = extractTurnTexts(lastTurn, cfg.captureMode);
    const senderIdFallback = [...extracted].reverse().find((x) => x.role === "user" && x.senderId)?.senderId;

    const provider = channelBase(String(ctx?.messageProvider || ctx?.channelId || "unknown"));
    const sessionKeyConversation = conversationIdFromSessionKey(ctx?.sessionKey);
    const knownConversation =
      firstString(
        event.conversationId,
        event.channelConversationId,
        ctx?.conversationId,
        sessionKeyConversation,
        lastConversationByChannel.get(provider),
        senderIdFallback,
        ctx?.accountId,
      ) || `${provider}:unknown`;
    const conversationId = normalizeConversationId(provider, knownConversation);
    lastConversationByChannel.set(provider, conversationId);

    logger.event("capture_conversation_resolved", {
      conversationId,
      provider,
      senderIdFallback: senderIdFallback || "-",
      sessionKeyConversation: sessionKeyConversation || "-",
    });

    const texts = extracted
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
      const firstTs = texts.find((t) => t.ts)?.ts;
      const ingestDate = firstTs ? toDateString(new Date(firstTs).getTime()) : toDateString();
      const ingestResult = await client.ingest({
        runId: ctx?.runId,
        agentId: ctx?.agentId,
        conversationId,
        channel: provider,
        date: ingestDate,
        items: texts.map((t) => ({
          role: t.role,
          content: t.text,
          ts: t.ts,
          sender: t.sender || (t.role === "assistant" ? firstString(ctx?.agentId, "assistant") : undefined),
          messageId: t.messageId,
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
