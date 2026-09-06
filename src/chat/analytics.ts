/**
 * Shared types and UI helpers for chat history and analytics.
 *
 * Types mirror rows returned by `chatDb` and the `/api/analytics` routes.
 * Formatting helpers are used by the history sidebar and stats breakdown.
 */

import type { Source } from "./sources";
import type { QueryStats, QueryStep, QueryStepCost } from "../queryCost";

/** Serializable LangSmith run node returned by the trace API. */
export type TraceRunNode = {
  id: string;
  traceId: string;
  name: string;
  runType: string;
  status: string;
  startTime: string | null;
  endTime: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
  inputs: unknown;
  outputs: unknown;
  childRuns: TraceRunNode[];
};

/** API payload for a LangSmith trace lookup. */
export type LangSmithTraceResult = {
  trace: TraceRunNode | null;
  traceUrl: string | null;
  /** LangSmith UI links keyed by pipeline step (summary may have several). */
  stepRunUrls: Partial<Record<QueryStep, string[]>>;
  unavailableReason: string | null;
};

/** Outcome of a persisted `/api/chat` response. */
export type ChatResponseStatus = "success" | "error" | "interrupted";

/** One query/response pair as shown in the history sidebar list. */
export type ExchangeSummary = {
  id: number;
  userId: string | null;
  queryContent: string;
  responseContent: string;
  normalizedQuery: string | null;
  langsmithTraceId: string | null;
  costUsd: number;
  durationMs: number;
  status: ChatResponseStatus;
  errorMessage: string | null;
  createdAt: number;
  stepBreakdown: QueryStepCost[];
};

/** Full exchange detail, including sources and live stats for the stats panel. */
export type ChatExchangeDetail = ExchangeSummary & {
  sources: Source[];
  stats: QueryStats;
};

/** Aggregated totals across all persisted exchanges for the analytics API. */
export type AnalyticsSummary = {
  queryCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  avgCostUsd: number;
  avgDurationMs: number;
  stepBreakdown: QueryStepCost[];
};

/** Paginated history list returned by `GET /api/analytics/queries`. */
export type ListExchangesResult = {
  items: ExchangeSummary[];
  total: number;
};

/**
 * Truncates text for sidebar previews.
 */
export function truncateText(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen).trimEnd()}…`;
}

/**
 * Formats a Unix timestamp for compact display.
 *
 * Uses relative labels ("Just now", "5m ago") for recent exchanges and falls
 * back to a locale-aware date string for older ones.
 */
export function formatExchangeTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Strips common markdown syntax for plain-text previews.
 */
export function stripMarkdownForPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Long-form labels for each pipeline step, shown in the stats breakdown. */
export const STEP_DESCRIPTIONS: Record<QueryStep, string> = {
  selector:
    "Normalizes the query, checks whether it is on topic, and chooses vector, SQL, or both retrieval paths.",
  embedding:
    "Embeds the query and searches Weaviate for semantically similar opinion chunks.",
  sql: "Generates SQL from the query and runs it against the opinion metadata database.",
  summary:
    "Summarizes each opinion's full text in parallel before composing the final answer.",
  rerank:
    "Reranks retrieved context so the most relevant passages are sent to the model.",
  chat: "Streams the final answer from GPT-4o using the retrieved sources as context.",
};

/** Short column headers for each pipeline step in cost tables. */
export const STEP_LABELS: Record<QueryStep, string> = {
  selector: "Selector",
  embedding: "Embedding",
  sql: "SQL",
  summary: "Summary",
  rerank: "Rerank",
  chat: "Chat",
};
