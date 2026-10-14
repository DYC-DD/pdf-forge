import type { Block } from "tesseract.js";
import { expect, it } from "vitest";

import { reconcileOcr } from "../features/pdf2docx/lib/ocrConsensus";
import {
  normalizeOcrLineSizes,
  ocrSpans,
} from "../features/pdf2docx/lib/ocrGeometry";
import { preferLineText } from "../features/pdf2docx/lib/ocrLines";
import { preferCellText } from "../features/pdf2docx/lib/ocrTables";
import type { TextSpan } from "../features/pdf2docx/types";

const reading = (text: string, confidence: number) => [
  { text, confidence } as TextSpan,
];

it("accepts corrections to several uncertain glyphs in a short line but rejects omissions and changed numbers", () => {
  expect(
    preferLineText(
      reading("三、同意參與土過必建販權利範圍:", 64),
      reading("三、同意參與土地及建物權利範圍:", 91)
    )
  ).toBe(true);
  expect(
    preferLineText(
      reading("請核對文件全部內容及附件", 72),
      reading("請核對文件", 99)
    )
  ).toBe(false);
  expect(
    preferLineText(
      [...reading("土地面積", 65), ...reading("34.25", 95)],
      reading("土地面積34.29", 99)
    )
  ).toBe(false);
  expect(
    preferLineText(
      reading("請核對文件全部內容及附件", 70),
      reading("這是完全不同的文字與其他句子", 99)
    )
  ).toBe(false);
});

it("normalizes a swollen OCR line without shrinking a heading with real clearance", () => {
  const line = (y: number, size: number, text = "文字內容") =>
    ({
      id: `${y}`,
      lineId: `${y}`,
      text,
      x: 50,
      y,
      width: 200,
      height: size,
      baseline: y + 10,
      size,
    }) as TextSpan;
  const prose = [line(100, 10), line(112, 18), line(124, 10)];
  normalizeOcrLineSizes(prose);
  expect(prose.map((s) => s.size)).toEqual([10, 10, 10]);
  const heading = [line(100, 10), line(130, 18), line(165, 10)];
  normalizeOcrLineSizes(heading);
  expect(heading[1].size).toBe(18);
});

it("does not let improvement in punctuation overwrite a better-read label", () => {
  const before = [
    ...reading("權利", 96),
    ...reading("範圍", 62),
    ...reading("(D)", 47),
  ];
  const after = [
    ...reading("權利", 91),
    ...reading("稀", 48),
    ...reading("圍", 52),
    ...reading("(D)", 89),
  ];
  expect(
    reconcileOcr(before, after)
      .map((span) => span.text)
      .join("")
  ).toBe("權利範圍(D)");
  expect(
    reconcileOcr(reading("MA", 10), reading("地段", 91))
      .map((span) => span.text)
      .join("")
  ).toBe("地段");
});

it("accepts a stronger independent table-label reading without treating confidence as accuracy", () => {
  expect(
    preferCellText(reading("人基站戰人", 45), reading("坐落地號", 91))
  ).toBe(true);
  expect(preferCellText(reading("地段", 91), reading("地人", 70))).toBe(false);
  expect(preferCellText(reading("契約全部內容", 80), reading("契約", 99))).toBe(
    false
  );
  expect(preferCellText(reading("建號", 45), reading("建號人人和說", 92))).toBe(
    false
  );
});

it("keeps numeric readings when the retry lacks strong evidence", () => {
  expect(preferCellText(reading("34.25", 82), reading("34.29", 88))).toBe(
    false
  );
  expect(preferCellText(reading("281", 92), reading("28]", 95))).toBe(false);
  expect(preferCellText(reading("281", 92), reading("287", 99))).toBe(false);
  expect(preferCellText(reading("281", 92), reading("281", 90))).toBe(false);
});

it("uses clipped glyph heights instead of a thin clause marker to size a row with swollen OCR boxes", () => {
  const blocks = [
    {
      paragraphs: [
        {
          lines: [
            {
              bbox: { x0: 10, y0: 100, x1: 160, y1: 112 },
              baseline: { x0: 10, x1: 160, y0: 112, y1: 112 },
              words: [
                {
                  text: "一",
                  confidence: 90,
                  bbox: { x0: 10, x1: 22, y0: 109, y1: 111 },
                },
                {
                  text: "合作",
                  confidence: 90,
                  bbox: { x0: 35, x1: 61, y0: 97, y1: 125 },
                },
                {
                  text: "條",
                  confidence: 90,
                  bbox: { x0: 61, x1: 74, y0: 97, y1: 125 },
                },
                {
                  text: "件",
                  confidence: 90,
                  bbox: { x0: 74, x1: 87, y0: 97, y1: 125 },
                },
                {
                  text: "池",
                  confidence: 0,
                  bbox: { x0: 90, x1: 100, y0: 120, y1: 140 },
                },
              ],
            },
          ],
        },
      ],
    },
  ] as unknown as Block[];
  const spans = ocrSpans(blocks, 1, 1);
  expect(spans.every((span) => span.size > 11 && span.size < 15)).toBe(true);
  expect(spans.map((span) => span.text).join("")).toBe("一合作條件");
});
