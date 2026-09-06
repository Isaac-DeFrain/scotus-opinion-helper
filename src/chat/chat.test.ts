import { formatSourceDisplayName, sourceListKey, type Source } from "./sources";

describe("formatSourceDisplayName", () => {
  const source = (
    caseName: string,
    docket?: string,
    pdfUrl = "https://example.com/opinion.pdf",
  ): Source => ({ caseName, docket, pdfUrl });

  it("returns the case name when it is unique in the list", () => {
    const sources = [
      source("Alpha v. Beta", "23-100"),
      source("Gamma v. Delta", "23-200"),
    ];
    const displayNames = sources.map((source) =>
      formatSourceDisplayName(source, sources),
    );

    expect(displayNames).toEqual(["Alpha v. Beta", "Gamma v. Delta"]);
  });

  it("appends the docket when multiple sources share a case name", () => {
    const sources = [
      source("Smith v. Jones", "24-1"),
      source("Smith v. Jones", "24-2"),
    ];
    const displayNames = sources.map((source) =>
      formatSourceDisplayName(source, sources),
    );

    expect(displayNames).toEqual([
      "Smith v. Jones (24-1)",
      "Smith v. Jones (24-2)",
    ]);
  });

  it("falls back to the case name when duplicates lack dockets", () => {
    const sources = [source("Smith v. Jones"), source("Smith v. Jones")];
    const displayNames = sources.map((source) =>
      formatSourceDisplayName(source, sources),
    );

    expect(displayNames).toEqual(["Smith v. Jones", "Smith v. Jones"]);
  });
});

describe("sourceListKey", () => {
  it("prefers docket, then pdfUrl, then case name", () => {
    const caseName = "A v. B";
    const docket = "23-1";
    const pdfUrl = "https://example.com/a.pdf";

    expect(
      sourceListKey({
        caseName,
        docket,
        pdfUrl,
      }),
    ).toBe(docket);

    expect(
      sourceListKey({
        caseName,
        pdfUrl,
      }),
    ).toBe(pdfUrl);

    expect(
      sourceListKey({
        caseName,
        pdfUrl: "",
      }),
    ).toBe(caseName);
  });
});
