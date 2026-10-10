import type { Block } from "tesseract.js";
import { describe, expect, it } from "vitest";

import {
  horizontalTextPage,
  preferHorizontalText,
} from "../features/pdf2docx/lib/ocrLayout";

const prose = (width = 420, count = 30) =>
  [
    {
      paragraphs: [
        {
          lines: Array.from({ length: count }, (_, i) => ({
            bbox: { x0: 80, y0: 60 + i * 18, x1: 80 + width, y1: 72 + i * 18 },
          })),
        },
      ],
    },
  ] as Block[];

describe("local OCR horizontal page retry", () => {
  it("requires dense page-wide prose and excludes grids, columns and sparse forms", () => {
    expect(horizontalTextPage(prose(), 600, [])).toBe(true);
    expect(horizontalTextPage(prose(240), 600, [])).toBe(false);
    expect(horizontalTextPage(prose(320), 600, [])).toBe(true);
    const columns = prose(300);
    columns[0].paragraphs[0].lines.forEach((line, i) => {
      line.bbox.x0 = i % 2 ? 300 : 0;
      line.bbox.x1 = line.bbox.x0 + 300;
    });
    expect(horizontalTextPage(columns, 600, [])).toBe(false);
    expect(horizontalTextPage(prose(420, 10), 600, [])).toBe(false);
    expect(
      horizontalTextPage(prose(), 600, [
        { x1: 50, x2: 550, y1: 50, y2: 50 },
        { x1: 50, x2: 550, y1: 100, y2: 100 },
        { x1: 50, x2: 50, y1: 50, y2: 100 },
        { x1: 550, x2: 550, y1: 50, y2: 100 },
      ])
    ).toBe(false);
  });
  it("recognizes prose split at punctuation without joining a column gutter", () => {
    const split = prose(210);
    const lines = split[0].paragraphs[0].lines;
    lines.push(
      ...lines.map((line) => ({
        ...line,
        bbox: { ...line.bbox, x0: 296, x1: 430 },
      }))
    );
    expect(horizontalTextPage(split, 600, [])).toBe(true);
    for (const line of lines.slice(30)) line.bbox.x0 = 320;
    expect(horizontalTextPage(split, 600, [])).toBe(false);
    // Classification must leave the OCR result untouched.
    expect(lines[0].bbox.x1).toBe(290);
  });
  it("accepts a more confident correction while rejecting lost or unrelated text", () => {
    const text =
      "第一條：文件內容需要逐字核對。第二條：所有資料在瀏覽器內處理。";
    const primary = { text, confidence: 85 };
    expect(
      preferHorizontalText(primary, {
        text: text.replace("核對", "校對"),
        confidence: 90,
      })
    ).toBe(true);
    expect(
      preferHorizontalText(primary, { text: text.slice(0, 15), confidence: 99 })
    ).toBe(false);
    expect(preferHorizontalText(primary, { text, confidence: 80 })).toBe(false);
    expect(
      preferHorizontalText(primary, {
        text: "無關文字".repeat(8),
        confidence: 99,
      })
    ).toBe(false);
  });
});
