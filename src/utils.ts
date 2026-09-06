import type { Source } from "./chat/sources";
import type { QueryStats } from "./queryCost";

export const QUERY_STATS_META_PREFIX = "\n\n<!--SCOTUS_QUERY_META:";
export const QUERY_STATS_META_SUFFIX = "-->";

/**
 * Format a date in seconds since Unix epoch to YYYY-MM-DD.
 *
 * @param seconds - The date in seconds since Unix epoch
 * @returns The date in YYYY-MM-DD
 */
export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().split("T")[0];
}

/**
 * Convert a base64-encoded JSON string to a Source array.
 *
 * @param b64 - The base64-encoded JSON string
 * @returns The Source array
 */
export function base64JsonToSources(b64: string): Source[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

type StreamMetaPayload = {
  stats: QueryStats;
  sources?: Source[];
};

function encodeStreamMetaPayload(
  payload: StreamMetaPayload | QueryStats,
): string {
  const json = JSON.stringify(payload);
  return typeof Buffer !== "undefined"
    ? Buffer.from(json, "utf8").toString("base64")
    : btoa(json);
}

function parseStreamMetaPayload(b64: string): {
  stats?: QueryStats;
  sources?: Source[];
} {
  const parsed = JSON.parse(atob(b64)) as StreamMetaPayload | QueryStats;

  if ("stats" in parsed && parsed.stats) {
    return { stats: parsed.stats, sources: parsed.sources };
  }

  return { stats: parsed as QueryStats };
}

/**
 * Appends encoded query stats (and optional sources) to a streamed chat response.
 *
 * Sources are appended in the body rather than response headers so large
 * citation lists do not exceed reverse-proxy header buffer limits.
 *
 * @param stats - Aggregated query cost breakdown
 * @param sources - Optional source citations for the answer
 * @returns Stream suffix containing base64-encoded JSON metadata
 */
export function encodeQueryStats(
  stats: QueryStats,
  sources?: Source[],
): string {
  const payload: StreamMetaPayload | QueryStats =
    sources && sources.length > 0 ? { stats, sources } : stats;

  return `${QUERY_STATS_META_PREFIX}${encodeStreamMetaPayload(payload)}${QUERY_STATS_META_SUFFIX}`;
}

/**
 * Separates streamed answer text from an appended metadata suffix.
 *
 * @param text - Accumulated stream text, possibly including a partial or full suffix
 * @returns Display content and parsed stats/sources when the suffix is complete
 */
export function splitStreamContentAndStats(text: string): {
  content: string;
  stats?: QueryStats;
  sources?: Source[];
} {
  const prefixIndex = text.indexOf(QUERY_STATS_META_PREFIX);
  if (prefixIndex === -1) {
    const partialStart = text.lastIndexOf("\n\n<!--");
    if (partialStart !== -1) {
      const tail = text.slice(partialStart);
      if (
        QUERY_STATS_META_PREFIX.startsWith(tail) ||
        tail.startsWith("\n\n<!--SCOTUS")
      ) {
        return { content: text.slice(0, partialStart) };
      }
    }

    return { content: text };
  }

  const content = text.slice(0, prefixIndex);
  const metaPart = text.slice(prefixIndex + QUERY_STATS_META_PREFIX.length);
  const suffixIndex = metaPart.indexOf(QUERY_STATS_META_SUFFIX);
  if (suffixIndex === -1) return { content };

  const b64 = metaPart.slice(0, suffixIndex);
  try {
    return { content, ...parseStreamMetaPayload(b64) };
  } catch {
    return { content };
  }
}

/**
 * Delay for a given number of milliseconds.
 *
 * @param ms - The number of milliseconds to delay
 * @returns A promise that resolves after the given number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
