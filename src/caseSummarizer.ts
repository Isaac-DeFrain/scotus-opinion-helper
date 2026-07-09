import type OpenAI from "openai";

import { langsmithCallOptions } from "./langsmith/langsmithTracing";
import { openaiClient } from "./openai";

export const CASE_SUMMARY_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You are a legal research assistant summarizing U.S. Supreme Court opinions.

Produce a clear, accurate summary of the opinion text provided. Cover the key facts, legal question, holding, and reasoning. Be concise but complete.`;

export type CaseSummaryInput = {
  caseName: string;
  text: string;
};

export type CaseSummaryResult = {
  caseName: string;
  summary: string;
  usage: OpenAI.Completions.CompletionUsage | undefined;
};

/**
 * Summarizes a single opinion's full text.
 *
 * @param caseName - The case name for context in the summary prompt
 * @param text - The full opinion text to summarize
 * @param normalizedQuery - The user's normalized question
 * @returns The case name, generated summary, and token usage
 */
export async function summarizeCase(
  caseName: string,
  text: string,
): Promise<CaseSummaryResult> {
  const openai = openaiClient();
  const completion = await openai.chat.completions.create(
    {
      model: CASE_SUMMARY_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Summarize the following Supreme Court opinion:

Case name: ${caseName}

Opinion text:
${text}`,
        },
      ],
    },
    langsmithCallOptions("summary"),
  );

  return {
    caseName,
    summary: completion.choices[0]?.message?.content?.trim() ?? "",
    usage: completion.usage,
  };
}

/**
 * Summarizes multiple opinions in parallel.
 *
 * @param cases - Case names and full opinion text to summarize
 * @param normalizedQuery - The user's normalized question
 * @returns Per-case summaries and their token usage
 */
export async function summarizeCases(cases: CaseSummaryInput[]): Promise<{
  results: CaseSummaryResult[];
  usages: (OpenAI.Completions.CompletionUsage | undefined)[];
}> {
  const results = await Promise.all(
    cases.map(({ caseName, text }) => summarizeCase(caseName, text)),
  );

  return {
    results,
    usages: results.map((result) => result.usage),
  };
}

/**
 * Replaces full opinion text in SQL rows with generated summaries.
 *
 * @param sqlRows - SQL rows that include a `text` field
 * @param summaries - Generated summaries keyed by case name
 * @returns Rows with `summary` instead of `text`
 */
export function applyCaseSummariesToSqlRows(
  sqlRows: Record<string, unknown>[],
  summaries: CaseSummaryResult[],
): Record<string, unknown>[] {
  const summaryByCase = new Map(
    summaries.map((result) => [result.caseName, result.summary]),
  );

  return sqlRows.map((row) => {
    const caseName = row.case_name;
    if (typeof caseName !== "string" || !("text" in row)) return row;

    const summary = summaryByCase.get(caseName);
    if (!summary) return row;

    const metadata = { ...row };
    delete metadata.text;
    return { ...metadata, summary };
  });
}

/**
 * Extracts case names and opinion text from SQL rows for summarization.
 *
 * @param sqlRows - SQL rows returned from a summary query
 * @returns Inputs suitable for {@link summarizeCases}
 */
export function extractCaseSummaryInputs(
  sqlRows: Record<string, unknown>[],
): CaseSummaryInput[] {
  return sqlRows.flatMap((row) => {
    const caseName = row.case_name;
    const text = row.text;

    if (typeof caseName !== "string" || typeof text !== "string") return [];
    return [{ caseName, text }];
  });
}
