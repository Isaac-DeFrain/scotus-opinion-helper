import { DB_PATH } from "../constants";
import { openReadOnlyDb } from "../db/db";
import { OpinionChunk } from "../opinion";
import { formatDate } from "../utils";

/**
 * A source returned alongside chat responses, linking to the original PDF
 */
export type Source = {
  caseName: string;
  docket?: string;
  pdfUrl: string;
};

type CaseNamed = Pick<Source, "caseName" | "docket">;

/**
 * Stable React key for a source in a citation list.
 */
export function sourceListKey(source: Source): string {
  return source.docket || source.pdfUrl || source.caseName;
}

/**
 * Formats a case name for display, appending the docket when multiple sources
 * share the same case name.
 */
export function formatSourceDisplayName<T extends CaseNamed>(
  source: T,
  allSources: readonly T[],
): string {
  const hasDuplicateCaseName =
    allSources.filter((s) => s.caseName === source.caseName).length > 1;

  if (hasDuplicateCaseName && source.docket) {
    return `${source.caseName} (${source.docket})`;
  }

  return source.caseName;
}

function formatSourceHeader(chunk: OpinionChunk, index: number): string {
  const headerParts = [
    chunk.caseName,
    chunk.docket ? `No. ${chunk.docket}` : undefined,
    chunk.opinionType,
    formatDate(chunk.date),
    `Justice: ${chunk.justice}`,
    `Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}`,
  ].filter(Boolean);

  return `<SOURCE_${index + 1}>
${headerParts.join(" | ")}

${chunk.text}
</SOURCE_${index + 1}>`;
}

/**
 * Builds the vector context for the chat agent
 *
 * @param chunks - The chunks to build the context from
 * @returns The context
 */
export function buildVectorContext(chunks: OpinionChunk[]): string {
  return chunks.map(formatSourceHeader).join("\n\n");
}

/**
 * Builds the SQL context for the chat agent
 *
 * @param sqlRows - The SQL rows to build the context from
 * @returns The context
 */
export function buildSqlContext(sqlRows: Record<string, unknown>[]): string {
  const rows = sqlRows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        /date/i.test(k) && typeof v === "number" ? formatDate(v) : v,
      ]),
    ),
  );
  return `<SQL_RESULTS>\n${JSON.stringify(rows, null, 2)}\n</SQL_RESULTS>`;
}

const SOURCE_DOCUMENT_PATTERN =
  /<SOURCE_\d+>[\s\S]*?<\/SOURCE_\d+>|<SQL_RESULTS>[\s\S]*?<\/SQL_RESULTS>/g;

function formatSqlResultDocument(row: Record<string, unknown>): string {
  return `<SQL_RESULTS>\n${JSON.stringify(row, null, 2)}\n</SQL_RESULTS>`;
}

function expandSqlResultsBlock(block: string): string[] {
  const match = block.match(/^<SQL_RESULTS>\n([\s\S]*?)\n<\/SQL_RESULTS>$/);
  if (!match) return [block];

  try {
    const rows = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return [block];

    return rows.map((row) =>
      formatSqlResultDocument(row as Record<string, unknown>),
    );
  } catch {
    return [block];
  }
}

/**
 * Splits tagged context into individual source documents for reranking.
 *
 * Each `<SOURCE_#>` block becomes one document. A `<SQL_RESULTS>` block
 * containing a JSON array is expanded so each row is reranked separately.
 *
 * @param context - Combined context containing `<SOURCE_#>` and/or `<SQL_RESULTS>` blocks
 * @returns Each source or SQL row as its own document, in source order
 */
export function splitSourceDocuments(context: string): string[] {
  if (!context.trim()) return [];

  return [...context.matchAll(SOURCE_DOCUMENT_PATTERN)].flatMap((match) => {
    const block = match[0];
    return block.startsWith("<SQL_RESULTS>")
      ? expandSqlResultsBlock(block)
      : [block];
  });
}

/**
 * Fetch the sources from the SQLite database
 *
 * @param dockets - The dockets to fetch the sources for
 * @returns The sources
 */
export async function getSources<
  T extends { caseName: string },
  R extends { case_name: string },
>(chunks: T[], sqlRows: R[]): Promise<Source[]> {
  const chunkCaseNames = chunks
    .map((c) => c.caseName)
    .filter(Boolean) as string[];
  const sqlCaseNames = sqlRows
    .map((r) => r.case_name)
    .filter(Boolean) as string[];
  const caseNames = [...new Set([...chunkCaseNames, ...sqlCaseNames])];

  let sources: Source[] = [];
  if (caseNames.length > 0) {
    const db = openReadOnlyDb(DB_PATH);
    try {
      const rows = await db
        .selectFrom("opinions")
        .select(["docket", "case_name", "pdf_url"])
        .where("case_name", "in", caseNames)
        .execute();

      sources = rows.map((r) => ({
        caseName: r.case_name,
        docket: r.docket,
        pdfUrl: r.pdf_url,
      }));
    } finally {
      await db.destroy();
    }
  }

  return sources;
}
