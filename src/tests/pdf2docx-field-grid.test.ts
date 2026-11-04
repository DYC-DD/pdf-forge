import { expect, it } from "vitest";

import {
  lineRuns,
  makeParagraph,
  paragraphText,
  type TextLine,
} from "../features/pdf2docx/lib/paragraphs";
import type { TextSpan } from "../features/pdf2docx/types";

function rows(): TextLine[] {
  const text = [
    ["ITEM", "DESCRIPTION", "TOTAL"],
    ["Book", "Paper", "12.00"],
    ["Pen", "Blue", "7.00"],
  ];
  const widths = [
    [24, 60, 36],
    [24, 30, 30],
    [18, 24, 24],
  ];
  return text.map((words, i) => {
    const spans: TextSpan[] = words.map((text, j) => ({
      id: `${i}:${j}`,
      text,
      x: j === 0 ? 50 : j === 1 ? 140 - widths[i][j] / 2 : 230 - widths[i][j],
      y: 80 + i * 16,
      height: 12,
      width: widths[i][j],
      baseline: 92 + i * 16,
      size: 12,
      font: "Helvetica",
      bold: false,
      italic: false,
      source: "pdf",
    }));
    return {
      kind: "line",
      spans,
      x: 50,
      y: 80 + i * 16,
      width: 180,
      height: 12,
      size: 12,
      baseline: 92 + i * 16,
    };
  });
}
const paragraph = (lines: TextLine[]) =>
  makeParagraph(lines, { x: 50, y: 0, width: 300, height: 400 }, 12);
it("keeps repeated left/center/right field geometry even below the column-gap threshold", () => {
  const input = rows(),
    before = structuredClone(input),
    p = paragraph(input);
  expect(
    p.runs.filter((r) => r.tabBefore !== undefined).map((r) => r.tabBefore)
  ).toEqual([110, 194, 125, 200, 128, 206]);
  expect(p.runs.map((r) => r.text.trim())).toEqual(
    input.flatMap((l) => l.spans.map((s) => s.text))
  );
  expect(p.runs.map((r) => r.width)).toEqual(
    input.flatMap((l) => l.spans.map((s) => s.width))
  );
  expect(paragraphText(p)).toBe(
    "ITEM DESCRIPTION TOTAL Book Paper 12.00 Pen Blue 7.00"
  );
  expect(input).toEqual(before);
});
it.each([
  "two-rows",
  "missing-field",
  "unaligned",
  "ordinary-gap",
  "ocr",
  "rotation",
  "math",
  "rtl",
  "distant",
])("does not infer a repeated field grid for %s", (kind) => {
  const input = rows();
  if (kind === "two-rows") input.pop();
  if (kind === "missing-field") input[2].spans.pop();
  if (kind === "unaligned") input[2].spans[1].x += 4;
  if (kind === "ordinary-gap")
    input.forEach((l) => (l.spans[1].x = l.spans[0].x + l.spans[0].width + 4));
  if (kind === "ocr") input[1].spans[1].source = "ocr";
  if (kind === "rotation") input[1].spans[1].rotation = 90;
  if (kind === "math") input[1].spans[1].text = "x = y";
  if (kind === "rtl") input[1].spans[1].text = "مرحبا";
  if (kind === "distant") {
    input[2].baseline += 100;
    input[2].spans.forEach((s) => (s.baseline += 100));
  }
  const firstRow = lineRuns(input[0]);
  expect(paragraph(input).runs.slice(0, firstRow.length)).toEqual(firstRow);
});
