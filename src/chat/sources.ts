/**
 * Chat source types and client-safe display helpers.
 *
 * Kept free of Node/SQLite imports so Next.js client components can use them
 * without pulling `better-sqlite3` into the browser bundle.
 */

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
