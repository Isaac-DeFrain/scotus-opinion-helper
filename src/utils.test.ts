import type { Source } from "./chat/sources";
import type { QueryStats } from "./queryCost";
import { encodeQueryStats, splitStreamContentAndStats } from "./utils";

describe("splitStreamContentAndStats", () => {
  const stats: QueryStats = {
    costUsd: 0.012,
    durationMs: 4200,
    breakdown: [
      {
        step: "chat",
        label: "Chat",
        description: "Chat step",
        costUsd: 0.012,
        durationMs: 4200,
      },
    ],
  };

  it("returns content unchanged when no suffix is present", () => {
    expect(splitStreamContentAndStats("Hello world")).toEqual({
      content: "Hello world",
    });
  });

  it("strips a partial suffix while streaming", () => {
    expect(splitStreamContentAndStats("Answer text\n\n<!--SCOTUS")).toEqual({
      content: "Answer text",
    });
  });

  it("parses content and stats from a completed suffix", () => {
    const text = `Answer text${encodeQueryStats(stats)}`;

    expect(splitStreamContentAndStats(text)).toEqual({
      content: "Answer text",
      stats,
    });
  });

  it("parses sources when included in the stream suffix", () => {
    const sources: Source[] = [
      {
        caseName: "Example v. Test",
        docket: "23-719",
        pdfUrl: "https://example.com/opinion.pdf",
      },
    ];
    const text = `Answer text${encodeQueryStats(stats, sources)}`;

    expect(splitStreamContentAndStats(text)).toEqual({
      content: "Answer text",
      stats,
      sources,
    });
  });
});
