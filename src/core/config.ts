export type CaptureMode = "all" | "everything";
export type QueryMode = "local" | "global" | "hybrid" | "naive" | "mix" | "bypass";

export type LightragConfig = {
  baseUrl: string;
  apiKey: string;
  queryMode: QueryMode;
  autoIngest: boolean;
  autoRecall: boolean;
  maxRecallResults: number;
  captureMode: CaptureMode;
  minCaptureLength: number;
  debug: boolean;
};

const ALLOWED_KEYS = [
  "baseUrl",
  "apiKey",
  "queryMode",
  "autoIngest",
  "autoRecall",
  "maxRecallResults",
  "captureMode",
  "minCaptureLength",
  "debug",
];

const VALID_QUERY_MODES: QueryMode[] = ["local", "global", "hybrid", "naive", "mix", "bypass"];

function assertAllowedKeys(value: Record<string, unknown>): void {
  const unknown = Object.keys(value).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`memory-lightrag-local config has unknown keys: ${unknown.join(", ")}`);
  }
}

function ensureNoTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function parseConfig(raw: unknown): LightragConfig {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  if (Object.keys(cfg).length > 0) assertAllowedKeys(cfg);

  const baseUrl = typeof cfg.baseUrl === "string" ? ensureNoTrailingSlash(cfg.baseUrl.trim()) : "";
  const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";

  if (!baseUrl || !apiKey) {
    throw new Error("memory-lightrag-local: baseUrl and apiKey are required");
  }

  const maxRecallResults = Number(cfg.maxRecallResults ?? 8);
  const minCaptureLength = Number(cfg.minCaptureLength ?? 10);

  const rawQueryMode = typeof cfg.queryMode === "string" ? cfg.queryMode as QueryMode : "naive";

  return {
    baseUrl,
    apiKey,
    queryMode: VALID_QUERY_MODES.includes(rawQueryMode) ? rawQueryMode : "naive",
    autoIngest: cfg.autoIngest === false ? false : true,
    autoRecall: cfg.autoRecall === false ? false : true,
    maxRecallResults: Number.isFinite(maxRecallResults)
      ? Math.max(1, Math.min(20, Math.floor(maxRecallResults)))
      : 8,
    captureMode: cfg.captureMode === "everything" ? "everything" : "all",
    minCaptureLength: Number.isFinite(minCaptureLength) ? Math.max(1, Math.floor(minCaptureLength)) : 10,
    debug: cfg.debug === true,
  };
}

export const lightragConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    baseUrl: {
      type: "string",
      description: "Base URL of the LightRAG local adapter API (e.g., http://127.0.0.1:8787)"
    },
    apiKey: {
      type: "string",
      description: "API key for authenticating with the LightRAG adapter"
    },
    queryMode: {
      type: "string",
      enum: ["local", "global", "hybrid", "naive", "mix", "bypass"],
      description: "LightRAG query mode. 'naive' (default) combines knowledge graph + vector search for best results",
      default: "naive"
    },
    autoIngest: {
      type: "boolean",
      description: "Whether to automatically capture conversation content and ingest into adapter",
      default: true
    },
    autoRecall: {
      type: "boolean",
      description: "Whether to automatically inject relevant memories before each AI turn",
      default: true
    },
    maxRecallResults: {
      type: "number",
      minimum: 1,
      maximum: 20,
      description: "Maximum number of memory snippets to inject per turn",
      default: 8
    },
    captureMode: {
      type: "string",
      enum: ["all", "everything"],
      description: "all: remove injected context blocks; everything: ingest as-is",
      default: "all"
    },
    minCaptureLength: {
      type: "number",
      minimum: 1,
      maximum: 200,
      description: "Skip captured text shorter than this length",
      default: 10
    },
    debug: {
      type: "boolean",
      description: "Enable verbose plugin diagnostics",
      default: false
    }
  },
  required: ["baseUrl", "apiKey"]
} as const;
