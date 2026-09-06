/**
 * Full breakdown view for a single persisted chat exchange (`/history/[id]`).
 *
 * Loads exchange metadata, step outputs, and an optional LangSmith trace tree
 * from the analytics API. Requests are scoped to the browser's anonymous
 * user id so users only see their own query history.
 */

"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";

import { ChatMarkdown } from "../ChatMarkdown";
import { LangSmithRunTree } from "./LangSmithRunTree";
import { StepOutputPanel } from "./StepOutputPanel";
import { StatsBreakdown } from "./StatsBreakdown";
import { ThemeToggle } from "../ThemeToggle";
import styles from "./history.module.css";
import chatStyles from "../page.module.css";
import type {
  ChatExchangeDetail,
  LangSmithTraceResult,
} from "@/src/chat/analytics";
import { formatExchangeTimestamp } from "@/src/chat/analytics";
import { formatSourceDisplayName, sourceListKey } from "@/src/chat/sources";
import { userScopedSearchParams } from "@/src/api/analytics";
import { formatCost, formatDuration } from "@/src/queryCost";
import { getOrCreateUserId } from "@/src/userId";

/** Maps persisted response status to a short label for the overview header. */
function statusLabel(status: ChatExchangeDetail["status"]): string {
  if (status === "success") return "Success";
  if (status === "error") return "Error";
  return "Interrupted";
}

export function ExchangeDetailPage({ exchangeId }: { exchangeId: number }) {
  // Stable per-browser id; appended to analytics requests for user scoping.
  const [userId] = useState(() => getOrCreateUserId());
  const [exchange, setExchange] = useState<ChatExchangeDetail | null>(null);
  const [traceResult, setTraceResult] = useState<LangSmithTraceResult | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // `/history/[id]` passes -1 when the route param is missing or invalid.
      if (exchangeId <= 0) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const params = userScopedSearchParams(userId);
        // Exchange detail is required; LangSmith trace is best-effort.
        const [exchangeRes, traceRes] = await Promise.all([
          fetch(`/api/analytics/queries/${exchangeId}?${params}`),
          fetch(`/api/analytics/queries/${exchangeId}/trace?${params}`),
        ]);

        if (!exchangeRes.ok) {
          throw new Error(
            exchangeRes.status === 404
              ? "This query was not found."
              : "Failed to load query details.",
          );
        }

        const exchangeData = (await exchangeRes.json()) as ChatExchangeDetail;
        const traceData = traceRes.ok
          ? ((await traceRes.json()) as LangSmithTraceResult)
          : null;

        if (!cancelled) {
          setExchange(exchangeData);
          setTraceResult(traceData);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load query details.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    // Ignore in-flight results when the id changes or the component unmounts.
    return () => {
      cancelled = true;
    };
  }, [exchangeId, userId]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <Link href="/" className={styles.backLink}>
            ← Back to chat
          </Link>
          <h1 className={styles.title}>
            <Image
              src="/icon.png"
              alt=""
              width={32}
              height={32}
              className={styles.titleIcon}
            />
            Query breakdown
          </h1>
        </div>
        <ThemeToggle />
      </header>

      {exchangeId <= 0 && !loading && (
        <p className={styles.errorMessage}>Invalid query id.</p>
      )}

      {loading && (
        <p className={styles.statusMessage}>Loading query details…</p>
      )}
      {error && <p className={styles.errorMessage}>{error}</p>}

      {exchange && (
        <div className={styles.content}>
          <section className={styles.overview}>
            <div className={styles.overviewMeta}>
              <span>{formatExchangeTimestamp(exchange.createdAt)}</span>
              <span className={styles.metaDivider} aria-hidden="true">
                ·
              </span>
              <span
                className={
                  exchange.status === "success"
                    ? styles.statusSuccess
                    : styles.statusError
                }
              >
                {statusLabel(exchange.status)}
              </span>
              <span className={styles.metaDivider} aria-hidden="true">
                ·
              </span>
              <StatsBreakdown
                label="Response time by step"
                summary={formatDuration(exchange.durationMs)}
                metric="duration"
                breakdown={exchange.stepBreakdown}
              />
              <span className={styles.metaDivider} aria-hidden="true">
                ·
              </span>
              <StatsBreakdown
                label="Estimated API cost by step"
                summary={formatCost(exchange.costUsd)}
                metric="cost"
                breakdown={exchange.stepBreakdown}
              />
            </div>

            {traceResult?.traceUrl && (
              <a
                href={traceResult.traceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.langsmithLink}
              >
                Open in LangSmith ↗
              </a>
            )}
          </section>

          <section className={styles.messageSection}>
            <h2 className={styles.sectionTitle}>Question</h2>
            <p className={styles.queryText}>{exchange.queryContent}</p>
            {exchange.normalizedQuery &&
              exchange.normalizedQuery !== exchange.queryContent && (
                <p className={styles.normalizedQuery}>
                  Normalized: {exchange.normalizedQuery}
                </p>
              )}
          </section>

          <section className={styles.messageSection}>
            <h2 className={styles.sectionTitle}>
              {exchange.status === "error" ? "Error" : "Answer"}
            </h2>
            {/* Distinguish hard failures, interrupted streams, and empty success. */}
            {exchange.status === "error" ? (
              <p className={styles.errorText}>
                {exchange.errorMessage ?? "Request failed."}
              </p>
            ) : exchange.responseContent ? (
              <ChatMarkdown
                content={exchange.responseContent}
                className={chatStyles.markdownBody}
              />
            ) : (
              <p className={styles.mutedText}>
                {exchange.status === "interrupted"
                  ? "The stream was interrupted before a full answer was saved."
                  : "No response was recorded."}
              </p>
            )}
          </section>

          {exchange.sources.length > 0 && (
            <section className={styles.messageSection}>
              <h2 className={styles.sectionTitle}>Sources</h2>
              <div className={chatStyles.sources}>
                {exchange.sources.map((source) => (
                  <a
                    key={sourceListKey(source)}
                    href={source.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={chatStyles.sourceLink}
                  >
                    {formatSourceDisplayName(source, exchange.sources)}
                  </a>
                ))}
              </div>
            </section>
          )}

          <section className={styles.messageSection}>
            <h2 className={styles.sectionTitle}>Pipeline steps</h2>
            <p className={styles.sectionIntro}>
              Each step below shows the inputs and outputs captured while this
              query ran.
            </p>
            <div className={styles.stepList}>
              {exchange.stats.breakdown.map((step) => (
                <StepOutputPanel
                  key={step.step}
                  step={step}
                  langsmithUrls={traceResult?.stepRunUrls?.[step.step]}
                />
              ))}
            </div>
          </section>

          <section className={styles.messageSection}>
            <h2 className={styles.sectionTitle}>LangSmith trace</h2>
            {traceResult?.trace ? (
              <>
                <p className={styles.sectionIntro}>
                  Full run tree from LangSmith, including nested LLM calls and
                  their inputs and outputs.
                </p>
                <LangSmithRunTree trace={traceResult.trace} />
              </>
            ) : (
              <p className={styles.mutedText}>
                {traceResult?.unavailableReason ??
                  "LangSmith trace data is not available for this query."}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
