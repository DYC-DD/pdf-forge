import JSZip from "jszip";
import { OPS } from "pdfjs-dist";
import type { Block } from "tesseract.js";
import { describe, expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { transparentStamp } from "../features/pdf2docx/lib/imageAppearance";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { ocrSpans } from "../features/pdf2docx/lib/ocrGeometry";
import { classifyPage } from "../features/pdf2docx/lib/pageObjects";
import {
  buildLines,
  groupParagraphs,
} from "../features/pdf2docx/lib/paragraphs";
import { scanRules } from "../features/pdf2docx/lib/scanRules";
import {
  applyTextAppearance,
  pdfFontName,
} from "../features/pdf2docx/lib/textAppearance";
import type { RawPage, TextSpan } from "../features/pdf2docx/types";

let id = 0;
const span = (
  text: string,
  x: number,
  y: number,
  width = 100,
  extra: Partial<TextSpan> = {}
): TextSpan => ({
  id: `${id++}`,
  text,
  x,
  y,
  width,
  height: 12,
  size: 12,
  baseline: y + 10,
  font: "DFKai-SB",
  bold: false,
  italic: false,
  source: "pdf",
  ...extra,
});
const page = (spans: TextSpan[]): RawPage => ({
  number: 1,
  width: 595,
  height: 842,
  spans,
  rules: [],
  figures: [],
  issues: [],
  source: "pdf",
});
const glyphs = (text: string) => [[...text].map((unicode) => ({ unicode }))];
async function xml(raw: RawPage) {
  const blob = await exportDocx(analyzeLayout([raw]), {
    preservePageBreaks: true,
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return { zip, text: await zip.file("word/document.xml")!.async("string") };
}

describe("PDF2docx object ownership and editable output", () => {
  it("does not turn decimal amounts into numbering or consume their digits", async () => {
    const raw = page([
      span("21.29", 50, 50),
      span("1.58", 50, 80),
      span("440.00%", 50, 110),
    ]);
    const { text } = await xml(raw);
    for (const value of ["21.29", "1.58", "440.00%"])
      expect(text).toContain(value);
    expect(text).not.toContain("<w:numPr>");
  });
  it("applies alignment once so a right-aligned number keeps the full cell width", () => {
    const region = { x: 0, y: 0, width: 60, height: 100 };
    const [p] = groupParagraphs(
      buildLines([span("21.29", 30, 10, 27)]),
      region,
      12
    );
    expect(p).toMatchObject({ align: "right", indent: 0 });
    const [center] = groupParagraphs(
      buildLines([span("Heading", 15, 10, 30)]),
      region,
      12
    );
    expect(center).toMatchObject({ align: "center", indent: 0 });
  });
  it("keeps centered address lines but lets ordinary body wraps flow", () => {
    const region = { x: 0, y: 0, width: 300, height: 100 };
    const centered = groupParagraphs(
      buildLines([span("Company", 100, 10, 100), span("Address", 110, 26, 80)]),
      region,
      12
    );
    expect(centered[0].runs[1].breakBefore).toBe(true);
    const body = groupParagraphs(
      buildLines([
        span("Body continues", 0, 10, 280),
        span("on next line", 0, 26, 100),
      ]),
      region,
      12
    );
    expect(body[0].runs[1].breakBefore).toBeUndefined();
  });
  it("separates underlines from independent rules without mutating source spans", async () => {
    const original = span("Underlined", 50, 50, 100);
    const raw = page([original]);
    raw.rules = [
      { x1: 50, x2: 150, y1: 62, y2: 62 },
      { x1: 50, x2: 500, y1: 100, y2: 100, color: "CC0000", thickness: 1 },
    ];
    const classified = classifyPage(raw);
    expect(classified.text[0].underline).toBe(true);
    expect(original.underline).toBeUndefined();
    expect(classified.lines).toHaveLength(1);
    const { text } = await xml(raw);
    expect(text).toContain('<w:u w:val="single"/>');
    expect(text).toContain('w:color="CC0000"');
    expect(text).not.toContain("txbxContent");
  });
  it("claims grid text once and preserves cell fills and red amounts", async () => {
    const raw = page([
      span("Title", 55, 55, 60),
      span("21.29", 155, 55, 40, { color: "FF0000" }),
      span("Data", 55, 105, 60),
      span("1.58", 155, 105, 40),
    ]);
    raw.rules = [50, 100, 150]
      .map((y) => ({ x1: 50, x2: 250, y1: y, y2: y }))
      .concat([50, 150, 250].map((x) => ({ x1: x, x2: x, y1: 50, y2: 150 })));
    raw.fills = [{ x: 50, y: 50, width: 200, height: 50, color: "ABCDEF" }];
    const classified = classifyPage(raw);
    expect(classified.tables).toHaveLength(1);
    expect(classified.text).toHaveLength(0);
    expect(classified.lines).toHaveLength(0);
    const { text } = await xml(raw);
    expect(text).toContain('w:fill="ABCDEF"');
    expect(text).toContain('w:val="FF0000"');
    expect(text.match(/21\.29/g)).toHaveLength(1);
    expect(text).not.toContain("<w:numPr>");
  });
  it("puts a scan page number in a real footer and preserves its start number", async () => {
    const raw = page([
      span("First clause", 60, 60, 350, { source: "ocr" }),
      span("10", 290, 755, 14, { source: "ocr" }),
    ]);
    raw.source = "ocr";
    const model = analyzeLayout([raw]);
    expect(model.pages[0].footer?.runs[0].text).toBe("10");
    const { zip, text } = await xml(raw);
    expect(text).toContain('<w:pgNumType w:start="10"/>');
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("PAGE");
    expect(footer).toContain('<w:sz w:val="24"/>');
    expect(footer).toContain('w:line="240" w:lineRule="exact"');
    expect(text).toContain('w:footer="1440"');
  });
  it("clears the preceding footer when the next source page has no page number", async () => {
    const numbered = page([
      span("First clause", 60, 60, 350, { source: "ocr" }),
      span("10", 290, 755, 14, { source: "ocr" }),
    ]);
    numbered.source = "ocr";
    const unnumbered = page([
      span("Attachment", 60, 60, 350, { source: "ocr" }),
    ]);
    unnumbered.number = 2;
    unnumbered.source = "ocr";
    const blob = await exportDocx(analyzeLayout([numbered, unnumbered]), {
      preservePageBreaks: true,
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const document = await zip.file("word/document.xml")!.async("string");
    // An absent reference would make Word inherit the preceding section's footer.
    expect(document.match(/<w:footerReference\b/g)).toHaveLength(2);
    expect(await zip.file("word/footer1.xml")!.async("string")).toContain(
      "PAGE"
    );
    expect(await zip.file("word/footer2.xml")!.async("string")).not.toContain(
      "PAGE"
    );
  });
  it("ignores whitespace-only spans for layout while still covering the source", () => {
    const model = analyzeLayout([
      page([span("Value", 50, 50), span(" ", 500, 500)]),
    ]);
    expect(model.issues.some((issue) => issue.code === "coverage")).toBe(false);
    expect(model.stats.paragraphs).toBe(1);
    expect(model.pages[0].margins.bottom).toBeGreaterThan(100);
  });
});

describe("PDF appearance", () => {
  it("removes a pale red stamp backdrop but leaves ordinary pictures intact", () => {
    const pixels = new Uint8ClampedArray(100 * 4).fill(255);
    for (let i = 0; i < 50; i++) {
      pixels[i * 4 + 1] = 220;
      pixels[i * 4 + 2] = 220;
    }
    const untouched = pixels.slice();
    expect(transparentStamp(untouched, false)).toBe(false);
    expect(untouched).toEqual(pixels);
    expect(transparentStamp(pixels, true)).toBe(true);
    expect(pixels[3]).toBe(35);
    expect(pixels[99 * 4 + 3]).toBe(0);
    const photo = new Uint8ClampedArray([80, 150, 40, 255, 160, 200, 70, 255]);
    expect(transparentStamp(photo, true)).toBe(false);
    expect(photo[3]).toBe(255);
  });
  it("decodes subset prefixes and UTF-8 font names without corrupting Latin names", () => {
    expect(pdfFontName("ABCDEF+DFKai-SB")).toBe("DFKai-SB");
    const encoded = [...new TextEncoder().encode("標楷體")]
      .map((x) => String.fromCharCode(x))
      .join("");
    expect(pdfFontName(encoded)).toBe("標楷體");
    expect(pdfFontName("Français")).toBe("Français");
  });
  it("tracks nested paint colors and resumes after a unique omitted paint glyph", () => {
    const spans = [
      span("Alpha", 0, 0),
      span("Total", 0, 20),
      span("Black", 0, 40),
    ];
    applyTextAppearance(spans, {
      fnArray: [
        OPS.showText,
        OPS.save,
        OPS.setFillRGBColor,
        OPS.showText,
        OPS.showText,
        OPS.restore,
        OPS.showText,
      ],
      argsArray: [
        glyphs("Alpha"),
        [],
        ["#ff0000"],
        glyphs("!"),
        glyphs("Total"),
        [],
        glyphs("Black"),
      ],
    });
    expect(spans.map((s) => s.color)).toEqual(["000000", "FF0000", "000000"]);
  });
});

describe("scan geometry", () => {
  it("splits false vertical list markers and borrows the neighboring horizontal baseline", () => {
    const word = (
      text: string,
      x0: number,
      y0: number,
      x1: number,
      y1: number
    ) => ({ text, confidence: 90, bbox: { x0, y0, x1, y1 } });
    const blocks = [
      {
        paragraphs: [
          {
            lines: [
              {
                bbox: { x0: 10, y0: 10, x1: 25, y1: 120 },
                baseline: { x0: 10, y0: 10, x1: 10, y1: 120 },
                words: [
                  word("一", 10, 10, 25, 40),
                  word("二", 10, 70, 25, 100),
                ],
              },
              {
                bbox: { x0: 50, y0: 10, x1: 250, y1: 40 },
                baseline: { x0: 50, x1: 250, y0: 40, y1: 40 },
                words: [word("條文", 50, 10, 120, 40)],
              },
              {
                bbox: { x0: 50, y0: 70, x1: 250, y1: 100 },
                baseline: { x0: 50, x1: 250, y0: 100, y1: 100 },
                words: [word("條文", 50, 70, 120, 100)],
              },
            ],
          },
        ],
      },
    ] as unknown as Block[];
    const spans = ocrSpans(blocks, 3, 1);
    expect(spans.every((s) => s.size < 13)).toBe(true);
    expect(spans[0].lineId).toBe(spans[2].lineId);
    expect(spans[1].baseline).toBeCloseTo(spans[3].baseline);
  });
  it("finds a scan grid with broken pixels without mistaking short text strokes for a table", () => {
    const width = 300,
      height = 300,
      data = new Uint8ClampedArray(width * height * 4).fill(255);
    const ink = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    };
    for (const p of [20, 140, 260]) {
      for (let v = 20; v <= 260; v++) {
        if (v % 43) {
          ink(v, p);
          ink(p, v);
        }
      }
    }
    const rules = scanRules({ width, height, data }, 1);
    expect(rules.filter((r) => r.y1 === r.y2)).toHaveLength(3);
    expect(rules.filter((r) => r.x1 === r.x2)).toHaveLength(3);
    const blank = new Uint8ClampedArray(width * height * 4).fill(255);
    expect(scanRules({ width, height, data: blank }, 1)).toEqual([]);
  });
});

describe("layout regressions from mixed document types", () => {
  it("splits a painted item number and label across an actual cell boundary", async () => {
    const raw = page([
      span("12 Name", 54, 60, 85, { advances: [6, 6, 10, 15, 15, 15, 18] }),
      span("Value", 160, 60, 45),
      span("Other", 85, 110, 50),
    ]);
    raw.rules = [50, 100, 150]
      .map((y) => ({ x1: 50, x2: 250, y1: y, y2: y }))
      .concat(
        [50, 75, 150, 250].map((x) => ({ x1: x, x2: x, y1: 50, y2: 150 }))
      );
    const model = analyzeLayout([raw]);
    expect(model.issues.some((issue) => issue.code === "coverage")).toBe(false);
    const table = model.pages[0].groups[0].columns[0].find(
      (block) => block.kind === "table"
    )!;
    if (table.kind !== "table") throw Error("Expected table");
    expect(
      table.cells.find((cell) => cell.row === 0 && cell.column === 0)
        ?.paragraphs[0].runs[0].text
    ).toBe("12");
    expect(
      table.cells.find((cell) => cell.row === 0 && cell.column === 1)
        ?.paragraphs[0].runs[0].text
    ).toBe("Name");
    const { text } = await xml(raw);
    expect(text.match(/>12</g)).toHaveLength(1);
    expect(text.match(/>Name</g)).toHaveLength(1);
  });
  it("keeps a negative indent when a long cell label straddles its left border", () => {
    const region = { x: 75, y: 50, width: 100, height: 50 };
    const p = groupParagraphs(
      buildLines([span("12 Long label", 55, 60, 140)]),
      region,
      12,
      true
    )[0];
    expect(p.align).toBe("left");
    expect(p.indent).toBe(-20);
  });
  it("reconstructs stacked fractions as editable Word equations and claims their source text", async () => {
    const raw = page([
      span("Ratio =", 50, 100, 60),
      span("Numerator", 120, 91, 100, { baseline: 101 }),
      span("Denominator", 125, 110, 90, { baseline: 120 }),
      span("Ordinary text", 50, 150, 200),
    ]);
    raw.rules = [{ x1: 120, x2: 220, y1: 107, y2: 107 }];
    const model = analyzeLayout([raw]);
    expect(model.issues.some((issue) => issue.code === "coverage")).toBe(false);
    const { text } = await xml(raw);
    expect(text).toContain("<m:f>");
    expect(text).toContain("<m:num>");
    expect(text).toContain("<m:den>");
    expect(text.match(/Numerator/g)).toHaveLength(1);
    expect(text.match(/Denominator/g)).toHaveLength(1);
    expect(text).not.toContain("txbxContent");
  });
  it("does not turn two centered underlined prose lines into a fraction", () => {
    const raw = page([
      span("A heading", 120, 91, 100, { baseline: 101 }),
      span("Another line", 125, 110, 90, { baseline: 120 }),
    ]);
    raw.rules = [{ x1: 120, x2: 220, y1: 107, y2: 107 }];
    expect(classifyPage(raw).text.every((span) => !span.fraction)).toBe(true);
  });
  it("moves recurring native footer text and its number into a real footer", async () => {
    const pages = [1, 2].map((n) => {
      const raw = page([
        span("Body", 50, 50, 200),
        span("Company", 50, 805, 70),
        span(String(n), 520, 805, 6),
      ]);
      raw.number = n;
      return raw;
    });
    const model = analyzeLayout(pages);
    expect(
      model.pages.every((page) =>
        page.footer?.runs.some((run) => run.pageNumber)
      )
    ).toBe(true);
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: true })
      ).arrayBuffer()
    );
    const body = await zip.file("word/document.xml")!.async("string");
    expect(body).not.toContain("Company");
    expect(await zip.file("word/footer1.xml")!.async("string")).toContain(
      "Company"
    );
  });
});

describe("scan illustration isolation", () => {
  it("keeps a large residual diagram while leaving OCR body text editable", async () => {
    const { scanGraphics } =
      await import("../features/pdf2docx/lib/scanGraphics");
    const width = 600,
      height = 800,
      data = new Uint8ClampedArray(width * height * 4).fill(255);
    const ink = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 30;
    };
    for (let y = 200; y < 500; y++)
      for (let x = 100; x < 500; x++) if ((x + y) % 12 < 3) ink(x, y);
    for (let x = 50; x < 350; x++) for (let y = 60; y < 70; y++) ink(x, y);
    const spans = [span("Body text", 50, 60, 300, { source: "ocr" })];
    const boxes = scanGraphics({ width, height, data }, 1, spans, []);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].y).toBeGreaterThan(150);
    expect(boxes[0].width).toBeGreaterThan(390);
  });
  it("does not rasterize ordinary OCR text or a small numeric cell residual", async () => {
    const { scanGraphics } =
      await import("../features/pdf2docx/lib/scanGraphics");
    const width = 600,
      height = 800,
      data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 50; y < 100; y++)
      for (let x = 50; x < 100; x++) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    expect(scanGraphics({ width, height, data }, 1, [], [])).toEqual([]);
  });
});
