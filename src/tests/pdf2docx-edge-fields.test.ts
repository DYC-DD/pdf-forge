import JSZip from "jszip";
import { expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import type { RawPage, TextSpan } from "../features/pdf2docx/types";

it.each([
  ["compact word", "ABCdefghij", 210, 52.84, "pdf", true, true],
  ["wider word", "ABCDEFGHIJKLM", 180, 82.84, "pdf", true, true],
  ["interior word", "ABCdefghij", 200, 52.84, "pdf", true, false],
  ["prose continuation", "continued text", 210, 52.84, "pdf", true, false],
  ["RTL field", "אבגדהוזחטי", 210, 52.84, "pdf", true, false],
  ["math field", "ABC=def", 210, 52.84, "pdf", true, false],
  ["OCR field", "ABCdefghij", 210, 52.84, "ocr", true, false],
  ["reflow mode", "ABCdefghij", 210, 52.84, "pdf", false, false],
] as const)(
  "anchors a %s at the source edge without shrinking or flattening",
  async (_name, text, x, width, source, preserve, rightTab) => {
    const span = (
      text: string,
      x: number,
      y: number,
      width: number
    ): TextSpan => ({
      id: `${x}:${y}`,
      text,
      x,
      y,
      width,
      height: 10,
      baseline: y + 10,
      size: 10,
      font: "NotoSerif-Regular",
      bold: false,
      italic: false,
      source,
    });
    const raw: RawPage = {
      number: 1,
      width: 300,
      height: 200,
      source,
      figures: [],
      rules: [],
      issues: [],
      spans: [
        span("Reference row", 25, 20, 237.84),
        span("Label", 25, 50, 120),
        span(text, x, 50, width),
      ],
    };
    const model = analyzeLayout([raw]),
      before = structuredClone(model);
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: preserve })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    const paragraph = [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gu)]
      .map((m) => m[0])
      .find((p) => p.includes("Label"))!;
    expect(paragraph).toBeDefined();
    expect(paragraph.includes('<w:tab w:val="right"')).toBe(rightTab);
    expect(paragraph).toContain(text);
    expect(paragraph).toContain('<w:sz w:val="20"');
    expect(xml).not.toContain("<w:drawing");
    if (rightTab) {
      const tab = Number(
        /<w:tab w:val="right" w:pos="(\d+)"/u.exec(paragraph)![1]
      );
      const margin = Number(/<w:pgMar[^>]*w:left="(\d+)"/u.exec(xml)![1]);
      expect(Math.abs(tab + margin - (x + width) * 20)).toBeLessThanOrEqual(1);
      expect(paragraph).toContain(
        `<w:fitText w:val="${Math.round(width * 20)}"`
      );
      const runs = [...paragraph.matchAll(/<w:r>.*?<\/w:r>/gu)].map(
        (m) => m[0]
      );
      expect(runs.find((r) => r.includes("<w:tab/>"))).not.toContain(
        "w:fitText"
      );
    }
    expect(model).toEqual(before);
  }
);
