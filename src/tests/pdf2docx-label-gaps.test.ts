import JSZip from "jszip";
import { expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import {
  buildLines,
  lineRuns,
  makeParagraph,
  paragraphText,
} from "../features/pdf2docx/lib/paragraphs";
import type { TextSpan } from "../features/pdf2docx/types";

const spans = (): TextSpan[] => {
  const base = {
    y: 80,
    height: 12,
    baseline: 92,
    size: 12,
    font: "Helvetica",
    bold: false,
    italic: false,
    source: "pdf" as const,
  };
  return [
    { ...base, id: "n", text: "1", x: 50, width: 7, color: "0072A6" },
    {
      ...base,
      id: "body",
      text: "Item title",
      x: 72,
      width: 60,
      color: "000000",
    },
  ];
};
it.each([true, false])(
  "retains a measured leading integer gap with same styling %s",
  (sameStyle) => {
    const input = spans();
    if (sameStyle) input[1].color = input[0].color;
    const before = structuredClone(input),
      lines = buildLines(input),
      runs = lineRuns(lines[0]);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      text: "Item title",
      tabBefore: 72,
      width: 60,
    });
    expect(
      paragraphText(
        makeParagraph(lines, { x: 50, y: 0, width: 300, height: 300 }, 12)
      )
    ).toBe("1 Item title");
    expect(input).toEqual(before);
  }
);
it.each([
  "small-gap",
  "ocr",
  "oblique",
  "fraction",
  "math",
  "rtl",
  "baseline",
  "not-leading",
])("does not infer a numbered label gap for %s", (kind) => {
  const input = spans();
  if (kind === "small-gap") input[1].x = 60;
  if (kind === "ocr") input.forEach((s) => (s.source = "ocr"));
  if (kind === "oblique") input[0].oblique = { angle: -30, baselineX: 50 };
  if (kind === "fraction")
    input[0].fraction = { numerator: "1", denominator: "2" };
  if (kind === "math") input[1].text = "x = y";
  if (kind === "rtl") input[1].text = "مرحبا";
  if (kind === "baseline") input[1].baseline += 2;
  if (kind === "not-leading")
    input.unshift({ ...input[0], id: "prefix", text: "See", x: 30, width: 15 });
  const line = {
    kind: "line" as const,
    spans: input,
    x: 30,
    y: 80,
    width: 110,
    height: 12,
    size: 12,
    baseline: 92,
  };
  expect(lineRuns(line).every((r) => r.tabBefore === undefined)).toBe(true);
});
it("exports a literal number and positioned title without synthesizing numbering or images", async () => {
  const input = analyzeLayout([
    {
      number: 1,
      width: 400,
      height: 400,
      spans: spans(),
      rules: [],
      figures: [],
      issues: [],
      source: "pdf",
    },
  ]);
  const zip = await JSZip.loadAsync(
    await (await exportDocx(input, { preservePageBreaks: true })).arrayBuffer()
  );
  const xml = await zip.file("word/document.xml")!.async("string");
  const tab = Number(/<w:tab w:val="left" w:pos="(\d+)"/u.exec(xml)![1]);
  const margin = Number(/<w:pgMar[^>]*w:left="(\d+)"/u.exec(xml)![1]);
  // Word tabs are relative to the page margin (36 pt after page setup),
  // not to the paragraph's 50 pt left edge. Retain the absolute source x.
  expect(tab + margin).toBe(72 * 20);
  expect(xml).toContain("<w:tab/>");
  expect(xml).toContain("Item title");
  expect(xml).not.toContain("<w:numPr>");
  expect(xml).not.toContain("<w:drawing");
});
