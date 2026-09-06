/**
 * Renders a single pipeline step's persisted output on the exchange detail page.
 *
 * Each step in a chat query (selector, SQL, embedding, etc.) stores a JSON blob
 * in `chat_step_costs.output`. This module maps those blobs to typed, readable
 * UI panels alongside timing and cost stats from {@link QueryStepCost}.
 */

"use client";

import { ChatMarkdown } from "../ChatMarkdown";
import styles from "./history.module.css";
import { formatSourceDisplayName } from "@/src/chat/sources";
import type {
  ChatStepOutput,
  EmbeddingStepOutput,
  RerankStepOutput,
  SelectorStepOutput,
  SqlStepOutput,
  SummaryStepOutput,
} from "@/src/pipelineOutputs";
import {
  formatCost,
  formatDuration,
  type QueryStep,
  type QueryStepCost,
} from "@/src/queryCost";

/** Narrow `unknown` JSON from chat.db before casting to step-specific output types. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First pipeline step: classifies the user query and normalizes it for downstream steps. */
function SelectorOutput({ output }: { output: SelectorStepOutput }) {
  return (
    <dl className={styles.outputList}>
      <div className={styles.outputRow}>
        <dt>Normalized query</dt>
        <dd>{output.normalizedQuery}</dd>
      </div>
      <div className={styles.outputRow}>
        <dt>On topic</dt>
        <dd>{output.isOnTopic ? "Yes" : "No"}</dd>
      </div>
      <div className={styles.outputRow}>
        <dt>Query type</dt>
        <dd>{output.queryType}</dd>
      </div>
      <div className={styles.outputRow}>
        <dt>Summary request</dt>
        <dd>{output.isSummary ? "Yes" : "No"}</dd>
      </div>
      <div className={styles.outputRow}>
        <dt>Reasoning</dt>
        <dd>{output.reason}</dd>
      </div>
    </dl>
  );
}

/** LLM-generated SQL plus execution results from the structured-data path. */
function SqlOutput({ output }: { output: SqlStepOutput }) {
  return (
    <>
      <dl className={styles.outputList}>
        <div className={styles.outputRow}>
          <dt>Generated SQL</dt>
          <dd>
            <pre className={styles.codeBlock}>{output.sqlQuery}</pre>
          </dd>
        </div>
        <div className={styles.outputRow}>
          <dt>Reason</dt>
          <dd>{output.reason}</dd>
        </div>
        <div className={styles.outputRow}>
          <dt>Rows returned</dt>
          <dd>{output.rowCount}</dd>
        </div>
      </dl>
      {output.rows.length > 0 && (
        <details className={styles.traceBlock}>
          <summary className={styles.traceBlockSummary}>Row preview</summary>
          {/* Full row set may be large; preview only the first few for the UI. */}
          <pre className={styles.tracePre}>
            {JSON.stringify(output.rows.slice(0, 5), null, 2)}
          </pre>
        </details>
      )}
    </>
  );
}

/** Vector search step: lists retrieved opinion chunks and their source cases. */
function EmbeddingOutput({ output }: { output: EmbeddingStepOutput }) {
  return (
    <dl className={styles.outputList}>
      <div className={styles.outputRow}>
        <dt>Model</dt>
        <dd>{output.model}</dd>
      </div>
      <div className={styles.outputRow}>
        <dt>Chunks retrieved</dt>
        <dd>{output.chunkCount}</dd>
      </div>
      {output.chunks.length > 0 && (
        <div className={styles.outputRow}>
          <dt>Chunk sources</dt>
          <dd>
            <ul className={styles.bulletList}>
              {output.chunks.map((chunk) => (
                <li
                  key={`${chunk.caseName}-${chunk.docket ?? ""}-${chunk.chunkIndex}`}
                >
                  {formatSourceDisplayName(chunk, output.chunks)} - chunk{" "}
                  {/* chunkIndex is 0-based in storage; show 1-based position to users. */}
                  {chunk.chunkIndex + 1}/{chunk.totalChunks}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  );
}

/** Per-case summaries produced when the selector routes to the summary path. */
function SummaryOutput({ output }: { output: SummaryStepOutput }) {
  return (
    <div className={styles.summaryList}>
      {output.summaries.map((item) => (
        <article key={item.caseName} className={styles.summaryCard}>
          <h4 className={styles.summaryCaseName}>{item.caseName}</h4>
          <p className={styles.summaryText}>{item.summary}</p>
        </article>
      ))}
    </div>
  );
}

/** Cohere rerank step: scores embedding hits before they feed the chat prompt. */
function RerankOutput({ output }: { output: RerankStepOutput }) {
  return (
    <>
      <dl className={styles.outputList}>
        <div className={styles.outputRow}>
          <dt>Documents submitted</dt>
          <dd>{output.documentCount}</dd>
        </div>
        <div className={styles.outputRow}>
          <dt>Results kept</dt>
          <dd>{output.resultCount}</dd>
        </div>
      </dl>
      {output.results.length > 0 && (
        <div className={styles.rerankList}>
          {output.results.map((result, index) => (
            <details key={index} className={styles.rerankItem}>
              <summary className={styles.rerankSummary}>
                Score {result.score ? result.score.toFixed(4) : "N/A"}
              </summary>
              <p className={styles.rerankDocument}>{result.document}</p>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

/** Final answer step: shows the assembled prompt and rendered model response. */
function ChatOutput({ output }: { output: ChatStepOutput }) {
  return (
    <>
      <dl className={styles.outputList}>
        <div className={styles.outputRow}>
          <dt>Model</dt>
          <dd>{output.model}</dd>
        </div>
      </dl>
      <details className={styles.traceBlock}>
        <summary className={styles.traceBlockSummary}>
          Prompt sent to model
        </summary>
        <pre className={styles.tracePre}>{output.userPrompt}</pre>
      </details>
      <div className={styles.chatResponse}>
        <h4 className={styles.stepOutputHeading}>Model response</h4>
        <ChatMarkdown
          content={output.response}
          className={styles.markdownBody}
        />
      </div>
    </>
  );
}

/** Fallback for legacy or unrecognized step output shapes. */
function GenericOutput({ output }: { output: unknown }) {
  return (
    <pre className={styles.tracePre}>{JSON.stringify(output, null, 2)}</pre>
  );
}

/**
 * Dispatches to a step-specific renderer.
 *
 * `output` is typed as `unknown` because it is deserialized JSON from chat.db;
 * the `step` field is the only reliable discriminator for casting.
 */
function StepOutputBody({
  step,
  output,
}: {
  step: QueryStep;
  output: unknown;
}) {
  if (!isRecord(output)) {
    return output !== undefined ? <GenericOutput output={output} /> : null;
  }

  switch (step) {
    case "selector":
      return <SelectorOutput output={output as SelectorStepOutput} />;
    case "sql":
      return <SqlOutput output={output as SqlStepOutput} />;
    case "embedding":
      return <EmbeddingOutput output={output as EmbeddingStepOutput} />;
    case "summary":
      return <SummaryOutput output={output as SummaryStepOutput} />;
    case "rerank":
      return <RerankOutput output={output as RerankStepOutput} />;
    case "chat":
      return <ChatOutput output={output as ChatStepOutput} />;
    default:
      return <GenericOutput output={output} />;
  }
}

export function StepOutputPanel({
  step,
  langsmithUrls,
}: {
  step: QueryStepCost;
  langsmithUrls?: string[];
}) {
  // LLM steps report tokens; rerank bills by Cohere search units instead.
  const tokenSummary =
    step.inputTokens != null || step.outputTokens != null
      ? `${step.inputTokens ?? 0} in / ${step.outputTokens ?? 0} out tokens`
      : step.searchUnits != null
        ? `${step.searchUnits} search units`
        : null;

  return (
    <section className={styles.stepPanel}>
      <header className={styles.stepPanelHeader}>
        <div>
          <h3 className={styles.stepPanelTitle}>{step.label}</h3>
          <p className={styles.stepPanelDesc}>{step.description}</p>
        </div>
        <div className={styles.stepPanelActions}>
          <div className={styles.stepPanelStats}>
            <span>{formatDuration(step.durationMs)}</span>
            <span aria-hidden="true"> · </span>
            <span>{formatCost(step.costUsd)}</span>
            {tokenSummary && (
              <>
                <span aria-hidden="true"> · </span>
                <span>{tokenSummary}</span>
              </>
            )}
          </div>
          {langsmithUrls && langsmithUrls.length > 0 && (
            <div className={styles.stepPanelLinks}>
              {langsmithUrls.map((url, index) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.langsmithLink}
                >
                  {langsmithUrls.length === 1
                    ? "Open in LangSmith ↗"
                    : `Open call ${index + 1} in LangSmith ↗`}
                </a>
              ))}
            </div>
          )}
        </div>
      </header>

      {step.output !== undefined ? (
        <div className={styles.stepPanelBody}>
          <StepOutputBody step={step.step} output={step.output} />
        </div>
      ) : (
        <p className={styles.stepPanelEmpty}>No step output was recorded.</p>
      )}
    </section>
  );
}
