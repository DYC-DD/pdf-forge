import { expect, it } from "vitest";

import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { buildLines, makeParagraph } from "../features/pdf2docx/lib/paragraphs";
import type { TextSpan } from "../features/pdf2docx/types";

const span = (id: string, index: number, width: number): TextSpan => {
  const angle = -30,
    rad = (angle * Math.PI) / 180;
  const x = 50 + index * 10,
    baseline = 100 + index * 20 * Math.cos(rad);
  return {
    id,
    text: id,
    x,
    y: baseline + width * Math.sin(rad) - 10,
    width: width * Math.cos(rad),
    height: 14 - width * Math.sin(rad),
    baseline,
    size: 14,
    font: "Helvetica",
    bold: false,
    italic: false,
    source: "pdf",
    oblique: { angle, baselineX: x },
  };
};
const source = () => [
  span("First", 0, 50),
  span("Second", 1, 160),
  span("Third", 2, 60),
];
const texts = (spans: TextSpan[]) =>
  buildLines(spans).map((line) => line.spans.map((s) => s.text).join(""));
it("orders a shared oblique frame without changing source geometry", () => {
  const spans = source(),
    before = structuredClone(spans);
  expect(texts(spans)).toEqual(["First", "Second", "Third"]);
  expect(spans).toEqual(before);
  const lines = buildLines(spans),
    p = makeParagraph(lines, { x: 50, y: 0, width: 300, height: 300 }, 12);
  expect(p.lineHeight).toBeCloseTo(20, 5);
  expect(p.sourceTextAngle).toBe(-30);
  const model = analyzeLayout([
    {
      number: 1,
      width: 400,
      height: 400,
      spans,
      rules: [],
      figures: [],
      issues: [],
      source: "pdf",
    },
  ]);
  const paragraphs = model.pages[0].groups
    .flatMap((g) => g.columns.flat())
    .filter((b) => b.kind === "paragraph");
  expect(paragraphs[0].lineHeight).toBeCloseTo(20, 5);
});
it.each(["horizontal", "ocr", "font", "distant"])(
  "does not reorder a %s run as shared slanted prose",
  (kind) => {
    const spans = source();
    if (kind === "horizontal") spans.forEach((s) => delete s.oblique);
    if (kind === "ocr")
      spans.forEach((s) => {
        s.source = "ocr";
        delete s.oblique;
      });
    if (kind === "font") spans[1].font = "Other";
    if (kind === "distant") spans[2].oblique!.baselineX += 300;
    expect(texts(spans)).toEqual(["Second", "First", "Third"]);
  }
);
it("keeps text with different reading axes out of the same row", () => {
  const first = span("First", 0, 50),
    second = {
      ...first,
      id: "Other",
      text: "Other",
      x: 200,
      oblique: undefined,
    };
  expect(buildLines([first, second], true)).toHaveLength(2);
});
