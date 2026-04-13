export interface BaseLogger {
  debug(msg: string): void;
  info?(msg: string): void;
  warn(msg: string): void;
  error?(msg: string): void;
}

export interface PluginLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  event(
    eventName: string,
    fields?: Record<string, unknown>,
    level?: "debug" | "info" | "warn" | "error",
  ): void;
  child(scope: string): PluginLogger;
}

function emitInfo(logger: BaseLogger, message: string): void {
  if (typeof logger.info === "function") {
    logger.info(message);
    return;
  }

  logger.debug(message);
}

function emitError(logger: BaseLogger, message: string): void {
  if (typeof logger.error === "function") {
    logger.error(message);
    return;
  }

  logger.warn(message);
}

function sanitizeKey(raw: string): string {
  const key = String(raw || "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
  return key || "field";
}

function formatValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[a-zA-Z0-9_.:/-]+$/.test(trimmed)) return trimmed;
    return JSON.stringify(trimmed);
  }
  if (value instanceof Error) {
    return JSON.stringify(value.message || String(value));
  }
  return JSON.stringify(value);
}

function formatEvent(eventName: string, fields?: Record<string, unknown>): string {
  const safeEvent = sanitizeKey(eventName || "event");
  if (!fields || typeof fields !== "object") return `event=${safeEvent}`;

  const parts: string[] = [`event=${safeEvent}`];
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  for (const [rawKey, rawValue] of entries) {
    if (rawValue === undefined) continue;
    const key = sanitizeKey(rawKey);
    const value = formatValue(rawValue);
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

export function createPluginLogger(
  base: BaseLogger,
  options?: { prefix?: string; debugEnabled?: boolean },
): PluginLogger {
  const debugEnabled = options?.debugEnabled === true;
  const prefix = String(options?.prefix || "plugin");

  const createScoped = (scopePath: string): PluginLogger => {
    const label = scopePath ? `${prefix}:${scopePath}` : prefix;
    const format = (message: string) => `${label}: ${message}`;

    return {
      debug(message: string) {
        if (!debugEnabled) return;
        emitInfo(base, format(message));
      },
      info(message: string) {
        emitInfo(base, format(message));
      },
      warn(message: string) {
        base.warn(format(message));
      },
      error(message: string) {
        emitError(base, format(message));
      },
      event(
        eventName: string,
        fields?: Record<string, unknown>,
        level: "debug" | "info" | "warn" | "error" = "debug",
      ) {
        const line = format(formatEvent(eventName, fields));
        if (level === "debug") {
          if (!debugEnabled) return;
          emitInfo(base, line);
          return;
        }
        if (level === "info") {
          emitInfo(base, line);
          return;
        }
        if (level === "warn") {
          base.warn(line);
          return;
        }
        emitError(base, line);
      },
      child(scope: string) {
        const trimmed = String(scope || "").trim();
        const nextScope = trimmed ? (scopePath ? `${scopePath}:${trimmed}` : trimmed) : scopePath;
        return createScoped(nextScope);
      },
    };
  };

  return createScoped("");
}
