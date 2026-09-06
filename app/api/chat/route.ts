/**
 * SCOTUS HELPER CHAT ENDPOINT
 *
 * This endpoint is used to chat with the SCOTUS helper.
 * It uses the OpenAI API to generate a response based on the query and the context.
 * The context is the retrieved chunks from the database.
 *
 * Successful, failed, and interrupted exchanges are persisted to `data/chat.db`
 * for the history sidebar and analytics API. Persistence errors are logged but
 * never fail the HTTP response.
 *
 * Pipeline (see {@link handleChatPipeline}):
 * selector → vector/SQL retrieval → optional summarization → rerank → gpt-4o stream.
 */

import { NextResponse, NextRequest } from "next/server";
import type OpenAI from "openai";

import { DB_PATH, EMBEDDING_MODEL } from "@/src/constants";
import { openReadOnlyDb } from "@/src/db/db";
import { connectWeaviate, searchDocuments } from "@/src/weaviate";
import { OpinionChunk, toOpinionChunk } from "@/src/opinion";
import { runSelector } from "@/src/api/selector";
import { chatRequestSchema } from "@/src/chat/request";
import {
  runSqlQueryGenerator,
  validateAndParseSqlQuery,
} from "@/src/api/sqlQueryGenerator";
import {
  applyCaseSummariesToSqlRows,
  extractCaseSummaryInputs,
  summarizeCases,
} from "@/src/caseSummarizer";
import {
  buildVectorContext,
  buildSqlContext,
  getSources,
} from "@/src/chat/chat";
import { openaiClient } from "@/src/openai";
import { rerank, selectRerankedDocuments } from "@/src/rerank";
import {
  buildQueryStats,
  chatStepCost,
  embeddingStepCost,
  rerankStepCost,
  selectorStepCost,
  sqlStepCost,
  summaryStepCost,
  type QueryStepCost,
} from "@/src/queryCost";
import {
  PipelineOutputCollector,
  buildChatStepOutput,
  buildEmbeddingStepOutput,
  buildRerankStepOutput,
  buildSqlStepOutput,
  buildSummaryStepOutput,
  type StepOutputs,
} from "@/src/pipelineOutputs";
import {
  persistChatQuery,
  persistChatResponse,
  persistLangSmithTraceId,
  persistNormalizedQuery,
} from "@/src/chat/persistence";
import {
  langsmithCallOptions,
  runWithLangSmithTrace,
  withLangSmithTraceHeader,
} from "@/src/langsmith/langsmithTracing";
import { encodeQueryStats } from "@/src/utils";

const currentDateForSystemPrompt = () => {
  const currentDate = new Date();
  const currentDateString = currentDate.toDateString();
  const currentDateMs = currentDate.getTime();
  return `${currentDateString} (${currentDateMs / 1000} Unix epoch seconds UTC)`;
};

/** OpenAI model used for the final grounded answer. */
const CHAT_MODEL = "gpt-4o";

/** System instructions for the streaming chat completion. */
const systemPrompt = () => `
You are a careful legal research assistant with the goal of helping users find and understand information about U.S. Supreme Court opinions.

Use ONLY the provided sources when answering the user's question and provide your reasoning.

NEVER comment on a date being in the future or about a case being outside the scope of your current data.

When citing a source, NEVER use the source number (e.g. "Source 1", "Source 2", etc.), instead use the case name and/or docket number.

Current date: ${currentDateForSystemPrompt()}.`;

/**
 * HTTP handler for `POST /api/chat`.
 *
 * Validates the request, inserts a `chat_queries` row, then runs the retrieval
 * pipeline inside a LangSmith root trace when persistence succeeds. Top-level
 * failures (bad JSON, validation, uncaught pipeline errors) return JSON 500 and
 * still attempt to record an error row when `queryId` is known.
 *
 * @param req - JSON body matching {@link chatRequestSchema}
 * @returns Streaming plain-text on success, JSON error otherwise
 */
export async function POST(req: NextRequest) {
  // Analytics state — accumulated across the pipeline and written to chat.db.
  let queryId: number | null = null;
  const stepCosts: QueryStepCost[] = [];
  const stepOutputs = new PipelineOutputCollector();

  try {
    const body = await req.json();
    const { query, userId } = chatRequestSchema.parse(body);

    // Persist the raw query immediately so early failures still appear in history.
    queryId = await persistChatQuery(query, userId);

    const runPipeline = () =>
      handleChatPipeline({
        query,
        userId,
        queryId,
        stepCosts,
        stepOutputs,
      });

    if (queryId === null) {
      return runPipeline();
    }

    const { result, traceId } = await runWithLangSmithTrace(
      {
        name: "chat",
        queryId,
        userId,
        onTraceStart: (id) => persistLangSmithTraceId(queryId!, id, userId),
      },
      runPipeline,
    );

    return withLangSmithTraceHeader(result, traceId);
  } catch (error) {
    console.error("Error in /api/chat:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to process query";

    // Top-level failures (validation, selector, retrieval) still get a row.
    await saveErrorResponse(
      queryId,
      stepCosts,
      stepOutputs.snapshot(),
      errorMessage,
    );

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * Mutable state threaded through the chat pipeline for analytics.
 *
 * `stepCosts` and `stepOutputs` are accumulated in place so both `POST` and
 * {@link handleChatPipeline} share the same collectors without passing return
 * values back through the LangSmith wrapper.
 */
type ChatPipelineState = {
  /** Raw user question from the request body. */
  query: string;
  /** Client-generated id for per-user history; optional. */
  userId?: string | null;
  /** `chat_queries.id` when persistence succeeded; null skips analytics writes. */
  queryId: number | null;
  /** Per-step cost and duration records for the response stats suffix. */
  stepCosts: QueryStepCost[];
  /** Intermediate agent outputs shown on the exchange detail page. */
  stepOutputs: PipelineOutputCollector;
};

/**
 * Persists a failed exchange when the pipeline aborts before or during streaming.
 *
 * Writes status `"error"` with any partial `stepCosts` / `stepOutputs` collected
 * before the failure. No-op when the initial query insert failed (`queryId` is null).
 *
 * @param queryId - Target `chat_queries` row, or null to skip
 * @param stepCosts - Costs accumulated so far
 * @param stepOutputs - Snapshot of pipeline step outputs
 * @param errorMessage - Human-readable failure reason stored on the response row
 * @param content - Partial assistant text (empty for pre-stream failures)
 */
async function saveErrorResponse(
  queryId: number | null,
  stepCosts: QueryStepCost[],
  stepOutputs: StepOutputs,
  errorMessage: string,
  content = "",
): Promise<void> {
  if (queryId === null) return;

  // Record partial pipeline progress when the request fails before streaming.
  await persistChatResponse({
    queryId,
    content,
    stats: stepCosts.length > 0 ? buildQueryStats(stepCosts) : undefined,
    stepOutputs,
    status: "error",
    errorMessage,
  });
}

/**
 * True when a stream write failed because the client already closed the connection.
 *
 * Next.js / nginx may close the downstream socket while the OpenAI iterator is
 * still producing tokens (e.g. after a proxy error or navigation away).
 */
function isStreamControllerClosedError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    ((err as NodeJS.ErrnoException).code === "ERR_INVALID_STATE" ||
      err.message.includes("Controller is already closed"))
  );
}

/**
 * Enqueues a chunk without throwing when the stream controller is already closed.
 *
 * @returns `false` when the client disconnected; `true` when the chunk was sent
 */
function safeStreamEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  chunk: Uint8Array,
): boolean {
  try {
    controller.enqueue(chunk);
    return true;
  } catch (err) {
    if (isStreamControllerClosedError(err)) return false;
    throw err;
  }
}

/** Closes the stream controller, ignoring "already closed" errors from disconnects. */
function safeStreamClose(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  try {
    controller.close();
  } catch (err) {
    if (!isStreamControllerClosedError(err)) throw err;
  }
}

/**
 * Runs the full retrieval-and-generation pipeline for one chat request.
 *
 * Steps:
 * 1. **Selector** — normalize query, check on-topic, choose `vector` / `sql` / `both`.
 * 2. **Vector** — embed query, search Weaviate (when routed).
 * 3. **SQL** — generate and run a read-only SQLite query (when routed).
 * 4. **Summary** — per-case LLM summaries when the selector marks `isSummary`.
 * 5. **Rerank** — Cohere rerank over combined vector + SQL context.
 * 6. **Chat** — stream `gpt-4o` answer; append sources and stats to the body.
 *
 * Returns JSON for validation/retrieval errors (400/500). On success returns a
 * `ReadableStream` plain-text body. Client disconnects during streaming are
 * recorded as `"interrupted"` rather than throwing.
 *
 * @param state - Shared pipeline inputs and analytics collectors
 * @returns `NextResponse` with either a stream or a JSON error body
 */
async function handleChatPipeline({
  query,
  userId,
  queryId,
  stepCosts,
  stepOutputs,
}: ChatPipelineState): Promise<NextResponse> {
  try {
    // Selector
    const selectorStartedAt = performance.now();
    const { response: selectorResponse, usage: selectorUsage } =
      await runSelector(query);

    stepCosts.push(
      selectorStepCost(selectorUsage, performance.now() - selectorStartedAt),
    );
    stepOutputs.set("selector", selectorResponse);

    const { normalizedQuery, isOnTopic, isSummary, queryType } =
      selectorResponse;

    if (queryId !== null) {
      // Attach selector output once normalization is known.
      await persistNormalizedQuery(queryId, normalizedQuery, userId);
    }

    if (!isOnTopic) {
      const errorMessage = `Query is not on topic: ${selectorResponse.reason}`;
      await saveErrorResponse(
        queryId,
        stepCosts,
        stepOutputs.snapshot(),
        errorMessage,
      );
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const openai = openaiClient();
    let chunks: OpinionChunk[] = [];

    // Vector search
    if (queryType === "vector" || queryType === "both") {
      const vectorStartedAt = performance.now();
      const client = await connectWeaviate();
      try {
        const embedding = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: normalizedQuery,
        });

        const queryVector = embedding.data[0]?.embedding;
        if (!queryVector) {
          const errorMessage = "Failed to embed query";
          await saveErrorResponse(
            queryId,
            stepCosts,
            stepOutputs.snapshot(),
            errorMessage,
          );
          return NextResponse.json({ error: errorMessage }, { status: 500 });
        }

        chunks = await searchDocuments(client, queryVector);
        stepCosts.push(
          embeddingStepCost(
            embedding.usage,
            performance.now() - vectorStartedAt,
          ),
        );
        stepOutputs.set(
          "embedding",
          buildEmbeddingStepOutput(EMBEDDING_MODEL, chunks),
        );
      } finally {
        await client.close();
      }
    }

    // SQL retrieval
    let sqlRows: Record<string, unknown>[] = [];

    if (queryType === "sql" || queryType === "both") {
      const sqlStartedAt = performance.now();
      const { response: sqlResponse, usage: sqlUsage } =
        await runSqlQueryGenerator(normalizedQuery);
      const db = openReadOnlyDb(DB_PATH);

      try {
        const compiledQuery = validateAndParseSqlQuery(sqlResponse.sqlQuery);
        const result = await db.executeQuery(compiledQuery);
        sqlRows = result.rows as Record<string, unknown>[];

        if (chunks.length === 0 && !isSummary && !hasText(sqlRows)) {
          console.debug("Fetching chunks for SQL results");

          const sqlChunksQuery = db
            .selectFrom("opinion_chunks")
            .selectAll()
            .where(
              "case_name",
              "in",
              sqlRows.map((r) => r.case_name as string),
            );

          const sqlChunks = await sqlChunksQuery.execute();
          chunks = sqlChunks.map(toOpinionChunk);
        }
      } finally {
        await db.destroy();
      }

      stepCosts.push(sqlStepCost(sqlUsage, performance.now() - sqlStartedAt));
      stepOutputs.set("sql", buildSqlStepOutput(sqlResponse, sqlRows));
    }

    // Case summarization
    if (isSummary && hasText(sqlRows)) {
      const summaryStartedAt = performance.now();
      const caseInputs = extractCaseSummaryInputs(sqlRows);
      const { results, usages } = await summarizeCases(caseInputs);

      sqlRows = applyCaseSummariesToSqlRows(sqlRows, results);
      stepCosts.push(
        summaryStepCost(usages, performance.now() - summaryStartedAt),
      );
      stepOutputs.set("summary", buildSummaryStepOutput(results));
    }

    const sources = await getSources(
      chunks,
      sqlRows as Extract<typeof sqlRows, { case_name: string }>[],
    );

    // Reranking
    const vectorContext = buildVectorContext(chunks);
    const sqlContext = buildSqlContext(sqlRows);
    const rerankStartedAt = performance.now();
    const rerankResult = await rerank(
      normalizedQuery,
      [vectorContext, sqlContext].filter(Boolean),
    );
    const selectedResults = selectRerankedDocuments(rerankResult.results);

    if (rerankResult.documentCount > 0) {
      stepCosts.push(
        rerankStepCost(
          rerankResult.searchUnits,
          performance.now() - rerankStartedAt,
        ),
      );
      stepOutputs.set(
        "rerank",
        buildRerankStepOutput(rerankResult.documentCount, selectedResults),
      );
    }

    // Chat
    const context = selectedResults.map(({ document }) => document);
    const chatUserPrompt = userPrompt(normalizedQuery, context);
    const chatStartedAt = performance.now();
    const stream = await openai.chat.completions.create(
      {
        model: CHAT_MODEL,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: chatUserPrompt,
          },
        ],
      },
      langsmithCallOptions("chat"),
    );

    const encoder = new TextEncoder();
    const streamState = { clientDisconnected: false };

    return new NextResponse(
      new ReadableStream<Uint8Array>({
        cancel() {
          streamState.clientDisconnected = true;
        },
        async start(controller) {
          let assistantContent = "";

          /** Writes partial assistant text with status `"interrupted"` to chat.db. */
          const persistInterrupted = async (errorMessage: string) => {
            if (queryId === null) return;

            stepOutputs.set(
              "chat",
              buildChatStepOutput(CHAT_MODEL, chatUserPrompt, assistantContent),
            );

            const stats =
              stepCosts.length > 0 ? buildQueryStats(stepCosts) : undefined;

            await persistChatResponse({
              queryId,
              content: assistantContent,
              sources,
              stats,
              stepOutputs: stepOutputs.snapshot(),
              status: "interrupted",
              errorMessage,
            });
          };

          try {
            let chatUsage: OpenAI.Completions.CompletionUsage | undefined;

            for await (const event of stream) {
              if (streamState.clientDisconnected) break;

              if (event.usage) chatUsage = event.usage;

              const token = event.choices[0]?.delta?.content ?? "";
              if (token) {
                assistantContent += token;
                if (!safeStreamEnqueue(controller, encoder.encode(token))) {
                  streamState.clientDisconnected = true;
                  break;
                }
              }
            }

            stepCosts.push(
              chatStepCost(chatUsage, performance.now() - chatStartedAt),
            );
            stepOutputs.set(
              "chat",
              buildChatStepOutput(CHAT_MODEL, chatUserPrompt, assistantContent),
            );

            const stats = buildQueryStats(stepCosts);

            if (
              !streamState.clientDisconnected &&
              !safeStreamEnqueue(
                controller,
                encoder.encode(encodeQueryStats(stats, sources)),
              )
            ) {
              streamState.clientDisconnected = true;
            }

            if (queryId !== null && !streamState.clientDisconnected) {
              // Write the completed exchange after the stream finishes.
              await persistChatResponse({
                queryId,
                content: assistantContent,
                sources,
                stats,
                stepOutputs: stepOutputs.snapshot(),
                status: "success",
              });
            } else if (queryId !== null && streamState.clientDisconnected) {
              await persistInterrupted("Client disconnected");
            }
          } catch (err) {
            console.error("Streaming error:", err);

            if (!streamState.clientDisconnected) {
              safeStreamEnqueue(
                controller,
                encoder.encode("\n\n[Stream interrupted]\n"),
              );
            }

            await persistInterrupted(
              err instanceof Error ? err.message : "Stream interrupted",
            );
          } finally {
            safeStreamClose(controller);
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Error in /api/chat:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to process query";

    await saveErrorResponse(
      queryId,
      stepCosts,
      stepOutputs.snapshot(),
      errorMessage,
    );

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * Builds the user message sent to the chat model.
 *
 * @param normalizedQuery - Selector-normalized question text
 * @param context - Reranked source documents (`<SOURCE_#>` / `<SQL_RESULTS>` blocks)
 */
function userPrompt(normalizedQuery: string, context: string[]): string {
  return `
  ${normalizedQuery}

  Sources:
  ${context.join("\n\n")}
  `;
}

/**
 * True when SQL rows include a `text` column (full opinion bodies).
 *
 * Used to decide whether case summarization can run and whether chunk fallback
 * is needed for citation links.
 */
function hasText(sqlRows: Record<string, unknown>[]): boolean {
  return sqlRows.length > 0 && "text" in sqlRows[0];
}
