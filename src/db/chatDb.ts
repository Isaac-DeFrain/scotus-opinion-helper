/**
 * SCOTUS Opinion Helper — chat analytics database
 *
 * Persists user queries and assistant responses separately in SQLite
 * (`data/chat.db`), along with per-step cost, duration, and LLM output for the
 * history sidebar and analytics API.
 */

import BetterSqlite3 from "better-sqlite3";
import { ColumnType, Generated, Kysely, SqliteDialect } from "kysely";
import fs from "fs";
import path from "path";

import type { Source } from "../chat/sources";
import type {
  AnalyticsSummary,
  ChatExchangeDetail,
  ChatResponseStatus,
  ExchangeSummary,
  ListExchangesResult,
} from "../chat/analytics";
import { STEP_DESCRIPTIONS } from "../chat/analytics";
import {
  parseStepOutput,
  serializeStepOutput,
  type StepOutputs,
} from "../pipelineOutputs";
import type { QueryStats, QueryStep, QueryStepCost } from "../queryCost";

/**
 * User message table — one row per `/api/chat` request.
 */
export interface ChatQueriesTable {
  id: Generated<number>;
  user_id: string | null;
  content: string;
  normalized_query: string | null; // set after the selector runs
  langsmith_trace_id: string | null; // root LangSmith trace for the request
  created_at: ColumnType<number, number | undefined, never>; // Unix epoch seconds
}

/**
 * Assistant response table — one row per query outcome (success, error, or
 * interrupted stream).
 */
export interface ChatResponsesTable {
  id: Generated<number>;
  query_id: number;
  content: string;
  sources: string | null; // JSON-serialized Source[]
  cost_usd: number;
  duration_ms: number;
  status: ChatResponseStatus;
  error_message: string | null;
  created_at: ColumnType<number, number | undefined, never>;
}

/**
 * Per-pipeline-step cost rows for a response. Stored in a child table so
 * analytics queries can SUM and GROUP BY step efficiently.
 */
export interface ChatStepCostsTable {
  id: Generated<number>;
  response_id: number;
  step: QueryStep;
  label: string;
  cost_usd: number;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  search_units: number | null; // Cohere rerank only
  output: string | null; // JSON-serialized step output
}

/**
 * Chat analytics database schema.
 */
export interface ChatDatabase {
  chat_queries: ChatQueriesTable;
  chat_responses: ChatResponsesTable;
  chat_step_costs: ChatStepCostsTable;
}

/**
 * SQL DDL for the chat analytics schema.
 */
export const CHAT_DDL = `
  CREATE TABLE IF NOT EXISTS chat_queries (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            TEXT,
    content            TEXT    NOT NULL,
    normalized_query   TEXT,
    langsmith_trace_id TEXT,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS chat_responses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id      INTEGER NOT NULL REFERENCES chat_queries(id),
    content       TEXT    NOT NULL,
    sources       TEXT,
    cost_usd      REAL    NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'success',
    error_message TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS chat_step_costs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id   INTEGER NOT NULL REFERENCES chat_responses(id),
    step          TEXT    NOT NULL,
    label         TEXT    NOT NULL,
    cost_usd      REAL    NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    search_units  INTEGER,
    output        TEXT
  );
`;

/** Input for {@link insertChatQuery}. */
export type InsertChatQueryInput = {
  content: string;
  userId?: string | null;
  normalizedQuery?: string | null;
  langsmithTraceId?: string | null;
};

/** Input for {@link insertChatResponse}. */
export type InsertChatResponseInput = {
  queryId: number;
  content: string;
  sources?: Source[];
  stats?: QueryStats;
  stepOutputs?: StepOutputs;
  status: ChatResponseStatus;
  errorMessage?: string | null;
};

/** Filters applied to `chat_queries` in analytics reads. */
export type AnalyticsFilter = {
  userId?: string | null;
  since?: number;
  until?: number;
};

/** Pagination and date-filter options for {@link listChatExchanges}. */
export type ListExchangesOptions = AnalyticsFilter & {
  limit: number;
  offset: number;
};

/** Snake_case row shape from a `chat_step_costs` query. */
type StepCostRow = {
  step: QueryStep;
  label: string;
  cost_usd: number;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  search_units: number | null;
  output: string | null;
};

/** Joined query + response row returned by list/detail queries. */
type ExchangeRow = {
  id: number;
  user_id: string | null;
  query_content: string;
  response_content: string;
  normalized_query: string | null;
  langsmith_trace_id: string | null;
  cost_usd: number;
  duration_ms: number;
  status: ChatResponseStatus;
  error_message: string | null;
  created_at: number;
  sources: string | null;
};

/**
 * Opens (or creates) the chat analytics SQLite database and applies {@link CHAT_DDL}.
 *
 * @param dbPath - Path to the database file, or `:memory:` for tests
 * @returns A read/write Kysely connection
 */
export function openChatDb(dbPath: string): Kysely<ChatDatabase> {
  const isInMemoryDb =
    dbPath === ":memory:" || dbPath.startsWith("file::memory:");

  if (!isInMemoryDb && !fs.existsSync(dbPath)) {
    console.debug("Chat database file does not exist. Creating:", dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
  }

  const sqlite = new BetterSqlite3(dbPath);
  sqlite.exec(CHAT_DDL);
  migrateChatDbSchema(sqlite);

  return new Kysely<ChatDatabase>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}

/**
 * Applies incremental schema updates for existing chat.db files.
 */
function migrateChatDbSchema(sqlite: BetterSqlite3.Database): void {
  const stepCostColumns = sqlite
    .prepare("PRAGMA table_info(chat_step_costs)")
    .all() as { name: string }[];

  if (!stepCostColumns.some((column) => column.name === "output")) {
    sqlite.exec("ALTER TABLE chat_step_costs ADD COLUMN output TEXT");
  }

  const queryColumns = sqlite
    .prepare("PRAGMA table_info(chat_queries)")
    .all() as { name: string }[];

  if (!queryColumns.some((column) => column.name === "user_id")) {
    sqlite.exec("ALTER TABLE chat_queries ADD COLUMN user_id TEXT");
  }

  if (!queryColumns.some((column) => column.name === "langsmith_trace_id")) {
    sqlite.exec("ALTER TABLE chat_queries ADD COLUMN langsmith_trace_id TEXT");
  }
}

type QueryAnalyticsBuilder = {
  where: (
    lhs: "chat_queries.created_at" | "chat_queries.user_id",
    op: ">=" | "<=" | "=",
    rhs: number | string,
  ) => QueryAnalyticsBuilder;
};

/** Returns true when reads/writes should be scoped to a specific user. */
export function isUserScoped(userId?: string | null): userId is string {
  return userId != null && userId !== "";
}

/** Applies optional user and created-at filters to joined analytics queries. */
function applyQueryAnalyticsFilter<T extends QueryAnalyticsBuilder>(
  query: T,
  filter: AnalyticsFilter,
): T {
  let next = query;

  if (isUserScoped(filter.userId)) {
    next = next.where("chat_queries.user_id", "=", filter.userId) as T;
  }

  if (filter.since !== undefined) {
    next = next.where("chat_queries.created_at", ">=", filter.since) as T;
  }

  if (filter.until !== undefined) {
    next = next.where("chat_queries.created_at", "<=", filter.until) as T;
  }

  return next;
}

/** Maps a {@link QueryStepCost} to a `chat_step_costs` insert row. */
function stepCostToRow(
  responseId: number,
  step: QueryStepCost,
  output?: unknown,
): Omit<ChatStepCostsTable, "id"> {
  return {
    response_id: responseId,
    step: step.step,
    label: step.label,
    cost_usd: step.costUsd,
    duration_ms: step.durationMs,
    input_tokens: step.inputTokens ?? null,
    output_tokens: step.outputTokens ?? null,
    search_units: step.searchUnits ?? null,
    output: output === undefined ? null : serializeStepOutput(output),
  };
}

/** Maps a DB step-cost row back to the API {@link QueryStepCost} shape. */
function rowToStepCost(row: StepCostRow): QueryStepCost {
  const step = row.step;
  const output = parseStepOutput(row.output);

  return {
    step,
    label: row.label,
    description: STEP_DESCRIPTIONS[step],
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    searchUnits: row.search_units ?? undefined,
    output,
  };
}

/** Parses a JSON `sources` column into {@link Source} objects. */
function parseSources(raw: string | null): Source[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Source[]) : [];
  } catch {
    return [];
  }
}

/** Rebuilds {@link QueryStats} from stored totals and step rows. */
function buildStats(
  costUsd: number,
  durationMs: number,
  breakdown: QueryStepCost[],
): QueryStats {
  return { costUsd, durationMs, breakdown };
}

/** Maps a joined exchange row to the camelCase {@link ExchangeSummary} API shape. */
function rowToExchangeSummary(
  row: ExchangeRow,
  stepBreakdown: QueryStepCost[],
): ExchangeSummary {
  return {
    id: row.id,
    userId: row.user_id,
    queryContent: row.query_content,
    responseContent: row.response_content,
    normalizedQuery: row.normalized_query,
    langsmithTraceId: row.langsmith_trace_id,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    stepBreakdown,
  };
}

/**
 * Loads step-cost rows for one or more response ids, grouped by response id.
 */
async function fetchStepBreakdownsByResponseId(
  db: Kysely<ChatDatabase>,
  responseIds: number[],
): Promise<Map<number, QueryStepCost[]>> {
  const map = new Map<number, QueryStepCost[]>();
  if (responseIds.length === 0) return map;

  const rows = await db
    .selectFrom("chat_step_costs")
    .select([
      "response_id",
      "step",
      "label",
      "cost_usd",
      "duration_ms",
      "input_tokens",
      "output_tokens",
      "search_units",
      "output",
    ])
    .where("response_id", "in", responseIds)
    .orderBy("id", "asc")
    .execute();

  for (const row of rows) {
    const existing = map.get(row.response_id) ?? [];
    existing.push(rowToStepCost(row));
    map.set(row.response_id, existing);
  }

  return map;
}

/** Maps {@link InsertChatQueryInput} to a `chat_queries` insert row. */
function chatQueryToRow(
  input: InsertChatQueryInput,
): Omit<ChatQueriesTable, "id" | "created_at"> {
  return {
    user_id: input.userId ?? null,
    content: input.content,
    normalized_query: input.normalizedQuery ?? null,
    langsmith_trace_id: input.langsmithTraceId ?? null,
  };
}

/**
 * Inserts a user query row.
 *
 * @param db    - Open chat database connection
 * @param input - Raw user message and optional pre-normalized text
 * @returns The new `chat_queries.id`
 */
export async function insertChatQuery(
  db: Kysely<ChatDatabase>,
  input: InsertChatQueryInput,
): Promise<number> {
  const result = await db
    .insertInto("chat_queries")
    .values(chatQueryToRow(input))
    .executeTakeFirstOrThrow();

  return Number(result.insertId);
}

/** Maps {@link InsertChatResponseInput} to a `chat_responses` insert row. */
function chatResponseToRow(
  input: InsertChatResponseInput,
): Omit<ChatResponsesTable, "id" | "created_at"> {
  const stats = input.stats;

  return {
    query_id: input.queryId,
    content: input.content,
    sources: input.sources ? JSON.stringify(input.sources) : null,
    cost_usd: stats?.costUsd ?? 0,
    duration_ms: stats?.durationMs ?? 0,
    status: input.status,
    error_message: input.errorMessage ?? null,
  };
}

/**
 * Inserts an assistant response row and its step-cost breakdown.
 *
 * @param db    - Open chat database connection
 * @param input - Response content, optional sources/stats, and outcome status
 * @returns The new `chat_responses.id`
 */
export async function insertChatResponse(
  db: Kysely<ChatDatabase>,
  input: InsertChatResponseInput,
): Promise<number> {
  const stats = input.stats;
  const result = await db
    .insertInto("chat_responses")
    .values(chatResponseToRow(input))
    .executeTakeFirstOrThrow();

  const responseId = Number(result.insertId);
  if (stats?.breakdown?.length) {
    await db
      .insertInto("chat_step_costs")
      .values(
        stats.breakdown.map((step) =>
          stepCostToRow(responseId, step, input.stepOutputs?.[step.step]),
        ),
      )
      .execute();
  }

  return responseId;
}

/**
 * Returns aggregate query count, cost/duration totals, averages, and a
 * per-step breakdown summed across all matching responses.
 *
 * @param db     - Open chat database connection
 * @param filter - Optional created-at bounds (Unix epoch seconds)
 */
export async function getAnalyticsSummary(
  db: Kysely<ChatDatabase>,
  filter: AnalyticsFilter,
): Promise<AnalyticsSummary> {
  const countQuery = applyQueryAnalyticsFilter(
    db
      .selectFrom("chat_responses")
      .innerJoin("chat_queries", "chat_queries.id", "chat_responses.query_id")
      .select(({ fn }) => fn.count<number>("chat_responses.id").as("count")),
    filter,
  );

  const countRow = await countQuery.executeTakeFirstOrThrow();
  const queryCount = Number(countRow.count ?? 0);

  const totalsQuery = applyQueryAnalyticsFilter(
    db
      .selectFrom("chat_responses")
      .innerJoin("chat_queries", "chat_queries.id", "chat_responses.query_id")
      .select(({ fn }) => [
        fn.sum<number>("chat_responses.cost_usd").as("total_cost_usd"),
        fn.sum<number>("chat_responses.duration_ms").as("total_duration_ms"),
      ]),
    filter,
  );

  const totalsRow = await totalsQuery.executeTakeFirstOrThrow();
  const totalCostUsd = Number(totalsRow.total_cost_usd ?? 0);
  const totalDurationMs = Number(totalsRow.total_duration_ms ?? 0);

  const stepQuery = applyQueryAnalyticsFilter(
    db
      .selectFrom("chat_step_costs")
      .innerJoin(
        "chat_responses",
        "chat_responses.id",
        "chat_step_costs.response_id",
      )
      .innerJoin("chat_queries", "chat_queries.id", "chat_responses.query_id")
      .select(["chat_step_costs.step", "chat_step_costs.label"])
      .select(({ fn }) => [
        fn.sum<number>("chat_step_costs.cost_usd").as("cost_usd"),
        fn.sum<number>("chat_step_costs.duration_ms").as("duration_ms"),
        fn.sum<number>("chat_step_costs.input_tokens").as("input_tokens"),
        fn.sum<number>("chat_step_costs.output_tokens").as("output_tokens"),
        fn.sum<number>("chat_step_costs.search_units").as("search_units"),
      ])
      .groupBy(["chat_step_costs.step", "chat_step_costs.label"]),
    filter,
  );

  const stepRows = await stepQuery.execute();
  const stepBreakdown = stepRows.map((row) =>
    rowToStepCost({
      step: row.step as QueryStep,
      label: row.label,
      cost_usd: Number(row.cost_usd ?? 0),
      duration_ms: Number(row.duration_ms ?? 0),
      input_tokens: row.input_tokens === null ? null : Number(row.input_tokens),
      output_tokens:
        row.output_tokens === null ? null : Number(row.output_tokens),
      search_units: row.search_units === null ? null : Number(row.search_units),
      output: null,
    }),
  );

  return {
    queryCount,
    totalCostUsd,
    totalDurationMs,
    avgCostUsd: queryCount > 0 ? totalCostUsd / queryCount : 0,
    avgDurationMs: queryCount > 0 ? totalDurationMs / queryCount : 0,
    stepBreakdown,
  };
}

/**
 * Lists persisted query/response exchanges, newest first.
 *
 * @param db      - Open chat database connection
 * @param options - Pagination limit/offset and optional created-at bounds
 * @returns Matching items and total count (ignoring pagination)
 */
export async function listChatExchanges(
  db: Kysely<ChatDatabase>,
  options: ListExchangesOptions,
): Promise<ListExchangesResult> {
  const filter: AnalyticsFilter = {
    userId: options.userId,
    since: options.since,
    until: options.until,
  };

  const countQuery = applyQueryAnalyticsFilter(
    db
      .selectFrom("chat_responses")
      .innerJoin("chat_queries", "chat_queries.id", "chat_responses.query_id")
      .select(({ fn }) => fn.count<number>("chat_responses.id").as("count")),
    filter,
  );

  const countRow = await countQuery.executeTakeFirstOrThrow();
  const total = Number(countRow.count ?? 0);

  const listQuery = applyQueryAnalyticsFilter(
    db
      .selectFrom("chat_responses")
      .innerJoin("chat_queries", "chat_queries.id", "chat_responses.query_id")
      .select([
        "chat_responses.id as id",
        "chat_queries.user_id as user_id",
        "chat_queries.content as query_content",
        "chat_responses.content as response_content",
        "chat_queries.normalized_query as normalized_query",
        "chat_queries.langsmith_trace_id as langsmith_trace_id",
        "chat_responses.cost_usd as cost_usd",
        "chat_responses.duration_ms as duration_ms",
        "chat_responses.status as status",
        "chat_responses.error_message as error_message",
        "chat_queries.created_at as created_at",
        "chat_responses.sources as sources",
      ])
      .orderBy("chat_queries.created_at", "desc")
      .orderBy("chat_responses.id", "desc")
      .limit(options.limit)
      .offset(options.offset),
    filter,
  );

  const rows = (await listQuery.execute()) as ExchangeRow[];
  const stepMap = await fetchStepBreakdownsByResponseId(
    db,
    rows.map((row) => row.id),
  );

  return {
    total,
    items: rows.map((row) =>
      rowToExchangeSummary(row, stepMap.get(row.id) ?? []),
    ),
  };
}

/**
 * Returns a single exchange by `chat_responses.id`, including sources and
 * full step breakdown.
 *
 * @param db - Open chat database connection
 * @param id - Response row id (used as the exchange id in the analytics API)
 * @returns The exchange detail, or `null` when not found
 */
export async function getChatExchange(
  db: Kysely<ChatDatabase>,
  id: number,
  userId?: string | null,
): Promise<ChatExchangeDetail | null> {
  let query = db
    .selectFrom("chat_responses")
    .innerJoin("chat_queries", "chat_queries.id", "chat_responses.query_id")
    .select([
      "chat_responses.id as id",
      "chat_queries.user_id as user_id",
      "chat_queries.content as query_content",
      "chat_responses.content as response_content",
      "chat_queries.normalized_query as normalized_query",
      "chat_queries.langsmith_trace_id as langsmith_trace_id",
      "chat_responses.cost_usd as cost_usd",
      "chat_responses.duration_ms as duration_ms",
      "chat_responses.status as status",
      "chat_responses.error_message as error_message",
      "chat_queries.created_at as created_at",
      "chat_responses.sources as sources",
    ])
    .where("chat_responses.id", "=", id);

  if (isUserScoped(userId)) {
    query = query.where("chat_queries.user_id", "=", userId);
  }

  const row = (await query.executeTakeFirst()) as ExchangeRow | undefined;
  if (!row) return null;

  const stepMap = await fetchStepBreakdownsByResponseId(db, [id]);
  const stepBreakdown = stepMap.get(id) ?? [];
  const summary = rowToExchangeSummary(row, stepBreakdown);

  return {
    ...summary,
    sources: parseSources(row.sources),
    stats: buildStats(summary.costUsd, summary.durationMs, stepBreakdown),
  };
}

/**
 * Stores the selector-normalized query text on an existing query row.
 *
 * Called after the selector runs so analytics can show the normalized form.
 *
 * @param db              - Open chat database connection
 * @param queryId         - `chat_queries.id` to update
 * @param normalizedQuery - Text returned by the selector agent
 */
export async function updateChatQueryNormalized(
  db: Kysely<ChatDatabase>,
  queryId: number,
  normalizedQuery: string,
  userId?: string | null,
): Promise<void> {
  let query = db
    .updateTable("chat_queries")
    .set({ normalized_query: normalizedQuery })
    .where("id", "=", queryId);

  if (isUserScoped(userId)) {
    query = query.where("user_id", "=", userId);
  }

  await query.execute();
}

/**
 * Stores the root LangSmith trace id on an existing query row.
 *
 * @param db      - Open chat database connection
 * @param queryId - `chat_queries.id` to update
 * @param traceId - Root LangSmith trace id for the chat request
 */
export async function updateChatQueryLangsmithTraceId(
  db: Kysely<ChatDatabase>,
  queryId: number,
  traceId: string,
  userId?: string | null,
): Promise<void> {
  let query = db
    .updateTable("chat_queries")
    .set({ langsmith_trace_id: traceId })
    .where("id", "=", queryId);

  if (isUserScoped(userId)) {
    query = query.where("user_id", "=", userId);
  }

  await query.execute();
}
