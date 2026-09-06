/**
 * Collapsible query-history sidebar: list of past exchanges, aggregate stats,
 * and helpers for loading, scrolling to, and stashing list-item DOM refs.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";

import { StatsBreakdown } from "./StatsBreakdown";
import styles from "../page.module.css";
import {
  formatExchangeTimestamp,
  stripMarkdownForPreview,
  truncateText,
  type AnalyticsSummary,
  type ExchangeSummary,
} from "@/src/chat/analytics";
import { formatCost, formatDuration } from "@/src/queryCost";
import { userScopedSearchParams } from "@/src/api/analytics";

type HistorySidebarProps = {
  items: ExchangeSummary[];
  summary: AnalyticsSummary | null;
  activeExchangeId: number | null;
  isOpen: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  itemRefs: React.RefObject<Map<number, HTMLAnchorElement>>;
};

/** Status chip for the list; successful exchanges show no label. */
function statusLabel(status: ExchangeSummary["status"]): string | null {
  if (status === "success") return null;
  if (status === "error") return "Error";
  return "Interrupted";
}

/**
 * Renders the history toggle and aside: aggregate summary, then each exchange
 * as a link with query/response previews and per-item duration/cost breakdowns.
 */
export function HistorySidebar({
  items,
  summary,
  activeExchangeId,
  isOpen,
  onToggle,
  onNavigate,
  itemRefs,
}: HistorySidebarProps) {
  return (
    <div className={styles.historyColumn}>
      <button
        type="button"
        className={styles.historyToggle}
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls="history-sidebar"
      >
        History
      </button>

      <aside
        id="history-sidebar"
        className={[
          styles.historySidebar,
          isOpen ? styles.historySidebarOpen : "",
        ].join(" ")}
        aria-label="Query history"
      >
        <div className={styles.historyHeader}>
          <h2 className={styles.historyTitle}>Chat History</h2>
          {summary && (
            <div className={styles.historySummary}>
              {summary.queryCount} queries ·{" "}
              <StatsBreakdown
                label="Total response time by step"
                summary={formatDuration(summary.totalDurationMs)}
                metric="duration"
                breakdown={summary.stepBreakdown}
              />
              {" · "}
              <StatsBreakdown
                label="Total estimated API cost by step"
                summary={formatCost(summary.totalCostUsd)}
                metric="cost"
                breakdown={summary.stepBreakdown}
              />
            </div>
          )}
        </div>

        <div className={styles.historyList}>
          {items.length === 0 ? (
            <p className={styles.historyEmpty}>No queries yet.</p>
          ) : (
            items.map((item) => {
              const status = statusLabel(item.status);
              const previewResponse = truncateText(
                stripMarkdownForPreview(item.responseContent),
                120,
              );

              return (
                <Link
                  key={item.id}
                  href={`/history/${item.id}`}
                  // Keep a map of anchors so keyboard/nav can scroll the active row into view.
                  ref={(node) => {
                    if (node) itemRefs.current.set(item.id, node);
                    else itemRefs.current.delete(item.id);
                  }}
                  onClick={onNavigate}
                  className={[
                    styles.historyItem,
                    activeExchangeId === item.id
                      ? styles.historyItemSelected
                      : "",
                  ].join(" ")}
                  aria-current={
                    activeExchangeId === item.id ? "page" : undefined
                  }
                >
                  <span className={styles.historyItemMeta}>
                    <span>{formatExchangeTimestamp(item.createdAt)}</span>
                    {status && (
                      <span className={styles.historyStatus}>{status}</span>
                    )}
                  </span>
                  <span className={styles.historyQuery}>
                    {truncateText(item.queryContent, 80)}
                  </span>
                  {previewResponse && (
                    <span className={styles.historyResponse}>
                      {previewResponse}
                    </span>
                  )}
                  <span className={styles.historyItemStats}>
                    <StatsBreakdown
                      label="Response time by step"
                      summary={formatDuration(item.durationMs)}
                      metric="duration"
                      breakdown={item.stepBreakdown}
                    />
                    <span aria-hidden="true"> · </span>
                    <StatsBreakdown
                      label="Estimated API cost by step"
                      summary={formatCost(item.costUsd)}
                      metric="cost"
                      breakdown={item.stepBreakdown}
                    />
                  </span>
                </Link>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

/** Scrolls the active history row into view when the selected exchange changes. */
export function useHistorySidebarScroll(
  activeExchangeId: number | null,
  itemRefs: React.RefObject<Map<number, HTMLAnchorElement>>,
): void {
  useEffect(() => {
    if (activeExchangeId === null) return;
    itemRefs.current.get(activeExchangeId)?.scrollIntoView({
      block: "nearest",
    });
  }, [itemRefs, activeExchangeId]);
}

/** Fetches the latest query list and aggregate summary for a user. */
export async function fetchHistoryData(userId: string): Promise<{
  items: ExchangeSummary[];
  summary: AnalyticsSummary;
}> {
  const params = new URLSearchParams({ userId, limit: "50" });
  const [queriesRes, summaryRes] = await Promise.all([
    fetch(`/api/analytics/queries?${params}`),
    fetch(`/api/analytics/summary?${userScopedSearchParams(userId)}`),
  ]);

  if (!queriesRes.ok || !summaryRes.ok) {
    throw new Error("Failed to load history");
  }

  const queries = (await queriesRes.json()) as { items: ExchangeSummary[] };
  const summary = (await summaryRes.json()) as AnalyticsSummary;

  return { items: queries.items, summary };
}

/**
 * Stable callback that reloads sidebar history and pushes results through
 * `onLoaded`. Errors are logged; callers keep the previous list.
 */
export function useFetchHistory(
  userId: string,
  onLoaded: (data: {
    items: ExchangeSummary[];
    summary: AnalyticsSummary;
  }) => void,
): () => Promise<void> {
  return useCallback(async () => {
    try {
      const data = await fetchHistoryData(userId);
      onLoaded(data);
    } catch (error) {
      console.error("Failed to refresh history:", error);
    }
  }, [onLoaded, userId]);
}

/** Mutable map from exchange id → list-item `<a>` for scroll-into-view. */
export function useHistoryItemRefs(): React.RefObject<
  Map<number, HTMLAnchorElement>
> {
  return useRef<Map<number, HTMLAnchorElement>>(new Map());
}
