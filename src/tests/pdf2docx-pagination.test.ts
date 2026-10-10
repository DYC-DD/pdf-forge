import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { fontName } from "../features/pdf2docx/lib/fontMetrics";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { detectOpenTables } from "../features/pdf2docx/lib/openTables";
import {
  buildLines,
  groupParagraphs,
  lineRuns,
  makeParagraph,
  paragraphText,
  withPageNumber,
} from "../features/pdf2docx/lib/paragraphs";
import { detectTables } from "../features/pdf2docx/lib/tables";
import type {
  DocumentModel,
  RawPage,
  Rule,
  TextSpan,
} from "../features/pdf2docx/types";

let serial = 0;
const span = (
  text: string,
  x: number,
  y: number,
  width = 150,
  extra: Partial<TextSpan> = {}
): TextSpan => ({
  id: String(serial++),
  text,
  x,
  y,
  width,
  height: 12,
  baseline: y + 10,
  size: 12,
  font: "Times-Roman",
  bold: false,
  italic: false,
  source: "pdf",
  ...extra,
});
const page = (spans: TextSpan[], rules: Rule[] = []): RawPage => ({
  number: 1,
  width: 600,
  height: 800,
  spans,
  rules,
  figures: [],
  issues: [],
  source: "pdf",
});
const region = { x: 50, y: 50, width: 500, height: 700 };
async function output(model: DocumentModel, preservePageBreaks = true) {
  const zip = await JSZip.loadAsync(
    await (await exportDocx(model, { preservePageBreaks })).arrayBuffer()
  );
  return { zip, xml: await zip.file("word/document.xml")!.async("string") };
}

describe("pagination regressions found in public PDFs", () => {
  it("keeps a centered affiliation above columns and advances spacing after a column band", () => {
    const model = analyzeLayout([
      page([
        span("Centered affiliation", 225, 50, 150),
        span("Left first", 50, 100, 200),
        span("Right first", 330, 100, 220),
        span("Left second", 50, 116, 201),
        span("Right second", 330, 116, 220),
        span("Full width caption", 50, 155, 500),
        span("Left below", 50, 200, 200),
        span("Right below", 330, 200, 220),
        span("Left last", 50, 216, 200),
        span("Right last", 330, 216, 220),
      ]),
    ]);
    expect(model.pages[0].groups.map((group) => group.columns.length)).toEqual([
      1, 2, 1, 2,
    ]);
    const paragraphs = model.pages[0].groups
      .flatMap((group) => group.columns.flat())
      .filter((block) => block.kind === "paragraph");
    expect(paragraphs.map(paragraphText)).toEqual([
      "Centered affiliation",
      "Left first Left second",
      "Right first Right second",
      "Full width caption",
      "Left below Left last",
      "Right below Right last",
    ]);
    expect(paragraphs[3].before).toBeGreaterThan(0);
    expect(paragraphs[3].before).toBeLessThan(30);
    expect(model.issues.some((issue) => issue.code === "coverage")).toBe(false);
  });

  it("preserves native line boundaries in page mode without inserting a second space", async () => {
    const paragraph = makeParagraph(
      buildLines([
        span("First source line", 50, 50, 460),
        span("Next source line", 50, 66, 240),
      ]),
      region,
      12
    );
    const model = analyzeLayout([page([span("placeholder", 50, 50)])]);
    model.pages[0].groups = [{ columns: [[paragraph]], gap: 0 }];
    const fixed = await output(model);
    const flow = await output(model, false);
    expect(fixed.xml).toMatch(/<w:br\/><w:t[^>]*>Next source line/);
    expect(flow.xml).not.toContain("<w:br/>");
    expect(flow.xml).toContain("> Next source line<");
    expect(fixed.xml).toContain('<w:widowControl w:val="false"/>');
    expect(
      await fixed.zip.file("word/settings.xml")!.async("string")
    ).toContain("w:noColumnBalance");
  });

  it("retains hanging-list geometry and lets Word wrap list continuations once", async () => {
    const paragraphs = groupParagraphs(
      buildLines([
        span("1. A long numbered item", 50, 50, 400),
        span("continuation of the same item", 98, 66, 400),
      ]),
      region,
      12
    );
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toMatchObject({
      role: "list",
      indent: 48,
      firstIndent: -48,
      lineCount: 2,
    });
    paragraphs[0].rightIndent = 20;
    const model = analyzeLayout([page([span("placeholder", 50, 50)])]);
    model.pages[0].groups = [{ columns: [paragraphs], gap: 0 }];
    const { xml } = await output(model);
    expect(xml).toContain("w:numPr");
    expect(xml).toMatch(/<w:ind[^>]*w:right="[1-9]\d*"/);
    expect(xml).toContain('w:hanging="960"');
    expect(xml).not.toContain("<w:br/>");
    expect(xml).not.toContain(">1. A long");
  });

  it("bounds distinct tab stops so dense tables cannot make Word reject the document", async () => {
    const paragraph = makeParagraph(
      buildLines([span("Field", 50, 50)]),
      region,
      12
    );
    paragraph.runs = Array.from({ length: 140 }, (_, i) => ({
      ...paragraph.runs[0],
      text: String(i),
      tabBefore: 60 + (i % 70) * 5,
    }));
    const model = analyzeLayout([page([span("placeholder", 50, 50)])]);
    model.pages[0].groups = [{ columns: [[paragraph]], gap: 0 }];
    const { xml } = await output(model);
    const positions = [
      ...xml.matchAll(/<w:tab w:val="left" w:pos="(\d+)"\/>/g),
    ].map((match) => Number(match[1]));
    expect(positions).toHaveLength(64);
    expect(new Set(positions).size).toBe(64);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(xml.match(/<w:tab\/>/g)).toHaveLength(140);
  });

  it("keeps native superscripts with their baseline and original font size", async () => {
    const lines = buildLines([
      span("Author", 50, 50, 40),
      span("1", 91, 46, 4, { height: 7, size: 7, baseline: 54 }),
      span("Following line", 50, 68, 150),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].size).toBe(12);
    expect(lineRuns(lines[0])[1]).toMatchObject({
      text: "1",
      size: 7,
      baselineShift: 6,
    });
    const model = analyzeLayout([page(lines.flatMap((line) => line.spans))]);
    const { xml } = await output(model);
    expect(xml).toContain('<w:position w:val="6pt"/>');
    expect(xml).toContain('<w:sz w:val="14"/>');
  });

  it.each(["第12頁，共99頁", "Page 12 of 99", "12 / 99"])(
    "keeps the total literal in %s",
    async (text) => {
      const model = analyzeLayout([
        page([span("Body", 50, 50), span(text, 230, 760, 140)]),
      ]);
      const footer = model.pages[0].footer!;
      expect(paragraphText(footer)).toBe(text);
      expect(
        footer.runs.filter((run) => run.pageNumber).map((run) => run.text)
      ).toEqual(["12"]);
      const { zip, xml } = await output(model);
      const footerXml = await zip.file("word/footer1.xml")!.async("string");
      expect(footerXml.match(/>PAGE</g)).toHaveLength(1);
      expect(footerXml).toContain("99");
      expect(xml).toContain('<w:pgNumType w:start="12"/>');
    }
  );

  it("creates one page field even when its digits have different styles", () => {
    const paragraph = makeParagraph(
      buildLines([
        span("Page 1", 50, 50, 36),
        span("2 of 99", 86, 50, 42, { bold: true }),
      ]),
      region,
      12
    );
    const result = withPageNumber(paragraph);
    expect(paragraphText(result)).toBe("Page 12 of 99");
    expect(result.runs.filter((run) => run.pageNumber)).toHaveLength(1);
    expect(result.runs.find((run) => run.pageNumber)?.width).toBeCloseTo(12);
    expect(
      result.runs.reduce((sum, run) => sum + (run.width ?? 0), 0)
    ).toBeCloseTo(78);
  });

  it.each([
    ["NimbusRomNo9L-Medi", "Times New Roman"],
    ["NimbusSans-Regular", "Arial"],
    ["CMR10", "Times New Roman"],
    ["CMTT10", "Courier New"],
  ])("maps %s to an available Word family", (font, expected) => {
    expect(fontName(font)).toBe(expected);
  });

  it("retains an explicit PDF word space even when glyph geometry touches", () => {
    expect(
      lineRuns(
        buildLines([
          span("Keywords", 50, 50, 45, { spaceAfter: true }),
          span("JavaScript", 95, 50, 50),
        ])[0]
      )
        .map((run) => run.text)
        .join("")
    ).toBe("Keywords JavaScript");
  });

  it("recognizes a double-stroke grid whose corner has a small endpoint gap", () => {
    const rules: Rule[] = [
      ...[50, 100, 100.6, 150].map((y) => ({ x1: 50, x2: 250, y1: y, y2: y })),
      ...[50, 150, 250].map((x) => ({
        x1: x,
        x2: x,
        y1: x === 150 ? 52.04 : 50,
        y2: 150,
      })),
      { x1: 50, x2: 250, y1: 50.6, y2: 50.6 },
    ];
    const { tables, used } = detectTables(
      rules,
      [
        span("A", 60, 60, 20),
        span("B", 160, 60, 20),
        span("C", 60, 110, 20),
        span("D", 160, 110, 20),
      ],
      12
    );
    expect(tables).toHaveLength(1);
    expect(tables[0].cells).toHaveLength(4);
    expect(used.size).toBe(4);
  });
});

describe("numeric tables with horizontal rules", () => {
  const rules = [
    { x1: 50, x2: 300, y1: 80, y2: 80 },
    { x1: 50, x2: 300, y1: 145, y2: 145 },
  ];
  const content = () => [
    span("Name", 55, 65, 45),
    span("Count", 165, 65, 35),
    span("Ratio", 250, 65, 35),
    ...[0, 1, 2, 3].flatMap((i) => [
      span(`Item ${i}`, 55, 83 + i * 16, 45),
      span(String(10 + i), 180, 83 + i * 16, 20),
      span(`${i + 1}.5x`, 260, 83 + i * 16, 25),
    ]),
  ];
  it("keeps numeric rows together in native cells without inventing a vertical grid", async () => {
    const model = analyzeLayout([page(content(), rules)]);
    expect(model.stats.tables).toBe(1);
    const table = model.pages[0].groups
      .flatMap((group) => group.columns.flat())
      .find((block) => block.kind === "table")!;
    expect(table.rows).toHaveLength(5);
    expect(table.columns).toHaveLength(3);
    expect(
      table.cells
        .filter((cell) => cell.row === 1)
        .map((cell) => cell.paragraphs.map(paragraphText).join(""))
    ).toEqual(["Item 0", "10", "1.5x"]);
    expect(model.issues.some((issue) => issue.code === "coverage")).toBe(false);
    const { xml } = await output(model);
    expect(xml.match(/<w:tr[ >]/g)).toHaveLength(5);
    expect(xml).toContain('<w:insideV w:val="none"');
    expect(xml).toContain('<w:bottom w:val="single"');
  });
  it("rejects prose, sparse rows and unbounded numeric text", () => {
    expect(detectOpenTables([], content(), 12).tables).toEqual([]);
    expect(
      detectOpenTables(
        rules,
        content().filter((_, index) => index !== 8),
        12
      ).tables
    ).toEqual([]);
    expect(
      detectOpenTables(
        rules,
        content().map((entry) => ({ ...entry, text: "Words" })),
        12
      ).tables
    ).toEqual([]);
  });
});
