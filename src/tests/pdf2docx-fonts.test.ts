import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import {
  createFontResolver,
  measuredScale,
} from "../features/pdf2docx/lib/fontMetrics";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import {
  buildLines,
  groupParagraphs,
  lineRuns,
  paragraphText,
} from "../features/pdf2docx/lib/paragraphs";
import type { RawPage, TextRun, TextSpan } from "../features/pdf2docx/types";

// A machine with Songti and Times, with distinct generic fallback metrics.
function measureContext() {
  return {
    font: "",
    measureText(text: string) {
      const unit = /Songti TC|PingFang TC/u.test(this.font)
        ? 12
        : /Times New Roman|Arial/u.test(this.font)
          ? 6
          : this.font.includes("monospace")
            ? 9
            : 7;
      return { width: Array.from(text).length * unit } as TextMetrics;
    },
  };
}
const run: TextRun = {
  text: "中文12",
  font: "PMingLiU",
  size: 12,
  bold: false,
  italic: false,
  fontScale: 100,
};
const span = (text: string, x: number, y: number): TextSpan => ({
  ...run,
  text,
  id: `${x}:${y}`,
  x,
  y,
  width: 22.8,
  height: 12,
  baseline: y + 10,
  source: "pdf",
});

describe("PDF2docx font metrics and source line widths", () => {
  it("selects an available same-family CJK font and measures Latin separately", () => {
    const resolver = createFontResolver(measureContext());
    const fonts = resolver.resolve("PMingLiU");
    expect(fonts).toEqual({
      ascii: "Times New Roman",
      hAnsi: "Times New Roman",
      eastAsia: "Songti TC",
    });
    expect(resolver.measure(run, fonts)).toBe(36);
    expect(measuredScale(run, 32, 36)).toBe(88);
    const ocrFonts = resolver.resolve("Noto Sans CJK TC");
    expect(ocrFonts).toMatchObject({ ascii: "Arial", eastAsia: "PingFang TC" });
    expect(resolver.measure(run, ocrFonts)).toBe(36);
  });
  it("does not widen glyphs to fill a positioning gap or trust implausible measurements", () => {
    expect(measuredScale(run, 54, 36)).toBe(100);
    expect(measuredScale(run, 3, 36)).toBeUndefined();
    expect(measuredScale(run, 30, undefined)).toBeUndefined();
  });
  it("does not invent leading spaces on source line breaks", () => {
    const p = groupParagraphs(
      buildLines([
        { ...span("Line 1", 50, 50), width: 40 },
        { ...span("Line 2", 50, 66), width: 40 },
      ]),
      { x: 50, y: 50, width: 100, height: 100 },
      12,
      true
    )[0];
    expect(p.runs[1]).toMatchObject({ text: "Line 2", breakBefore: true });
    expect(paragraphText(p)).toBe("Line 1 Line 2");
  });
  it("positions a tabbed field without adding another leading space", () => {
    const [p] = groupParagraphs(
      buildLines(
        [
          { ...span("Name", 50, 50), width: 30 },
          { ...span("Value", 150, 50), width: 30 },
        ],
        true
      ),
      { x: 50, y: 50, width: 200, height: 50 },
      12
    );
    expect(p.runs[1]).toMatchObject({ text: "Value", tabBefore: 150 });
    expect(paragraphText(p)).toBe("Name Value");
  });
  it("uses the actual extent of overlapping OCR word boxes without dropping text", () => {
    const [line] = buildLines([
      { ...span("甲乙", 50, 50), source: "ocr", width: 24 },
      { ...span("丙", 67, 50), source: "ocr", width: 12 },
      { ...span("丁", 72, 50), source: "ocr", width: 12 },
    ]);
    expect(lineRuns(line)).toMatchObject([{ text: "甲乙丙丁", width: 34 }]);
  });
  it("keeps a thin OCR clause marker on its overlapping row without merging adjacent rows", () => {
    const lines = buildLines([
      {
        ...span("一", 50, 55),
        source: "ocr",
        width: 12,
        height: 2,
        baseline: 57,
        size: 4,
      },
      {
        ...span("、正文", 65, 50),
        source: "ocr",
        width: 36,
        baseline: 62,
      },
      {
        ...span("內容", 101, 50),
        source: "ocr",
        width: 24,
        baseline: 62,
      },
      { ...span("下一行", 65, 66), source: "ocr", width: 36 },
    ]);
    expect(lines).toHaveLength(2);
    expect(
      lineRuns(lines[0])
        .map((run) => run.text)
        .join("")
    ).toBe("一、正文內容");
    expect(lines[1].spans[0].text).toBe("下一行");
  });
  it("leaves room for thick cell borders while retaining the original text size", async () => {
    const raw: RawPage = {
      number: 1,
      width: 595,
      height: 842,
      source: "pdf",
      figures: [],
      issues: [],
      spans: [
        span("甲乙", 52, 51),
        span("丙丁", 82, 51),
        span("戊己", 52, 66),
        span("庚辛", 82, 66),
      ],
      rules: [50, 65, 80]
        .map((y) => ({ x1: 50, x2: 110, y1: y, y2: y, thickness: 1 }))
        .concat(
          [50, 80, 110].map((x) => ({
            x1: x,
            x2: x,
            y1: 50,
            y2: 80,
            thickness: 1,
          }))
        ),
    };
    const blob = await exportDocx(analyzeLayout([raw]), {
      preservePageBreaks: true,
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('w:line="260" w:lineRule="exact"');
    expect(xml).toContain('<w:sz w:val="24"/>');
    expect(xml.match(/<w:tc>/g)).toHaveLength(4);
  });
  it("writes measured editable table text at its original font size without automatic mixed-script gaps", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return measureContext();
        }
      }
    );
    try {
      const raw: RawPage = {
        number: 1,
        width: 595,
        height: 842,
        source: "pdf",
        figures: [],
        issues: [],
        spans: [
          span("項次", 52, 52),
          span("名稱", 82, 52),
          span("數量", 52, 72),
          span("內容", 82, 72),
        ],
        rules: [50, 70, 90]
          .map((y) => ({ x1: 50, x2: 110, y1: y, y2: y }))
          .concat([50, 80, 110].map((x) => ({ x1: x, x2: x, y1: 50, y2: 90 }))),
      };
      const blob = await exportDocx(analyzeLayout([raw]), {
        preservePageBreaks: true,
      });
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xml = await zip.file("word/document.xml")!.async("string");
      expect(xml).toContain('w:eastAsia="Songti TC"');
      expect(xml).toContain('<w:w w:val="95"/>');
      expect(xml).toContain('<w:sz w:val="24"/>');
      expect(xml).toContain('<w:autoSpaceDE w:val="false"/>');
      expect(xml).not.toContain("txbxContent");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
