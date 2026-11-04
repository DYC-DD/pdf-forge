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
  makeParagraph,
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
  it("keeps jittered native labels on one row while separating the next row", () => {
    const labels = [152.142, 153.144, 153.27, 153.834, 153.834].map(
      (baseline, index) => ({
        ...span(
          ["Mercury", "Earth", "Jupiter", "Uranus", "Neptune"][index],
          30 + index * 80,
          baseline - 6
        ),
        size: 6,
        height: 6,
        baseline,
      })
    );
    const lines = buildLines(
      [
        ...labels,
        { ...span("Next row", 30, 160), size: 6, height: 6, baseline: 166 },
      ],
      true
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].spans.map((item) => item.text)).toEqual([
      "Mercury",
      "Earth",
      "Jupiter",
      "Uranus",
      "Neptune",
    ]);
    expect(lines[0].baseline).toBe(153.27);
    expect(lines[1].spans.map((item) => item.text)).toEqual(["Next row"]);
    // Wide gaps still split separate fields when the caller requests it.
    expect(buildLines(labels)).toHaveLength(5);
  });
  it.each(["font", "size", "ocr", "block"])(
    "does not use native row averaging across a %s change",
    (kind) => {
      const labels = [152.142, 153.144, 153.27, 153.834].map(
        (baseline, index) => ({
          ...span(`Label ${index}`, 30 + index * 80, baseline - 6),
          size: 6,
          height: 6,
          baseline,
        })
      );
      if (kind === "font") labels[3].font = "Other font";
      if (kind === "size") labels[3].size = 7;
      if (kind === "ocr") labels[3].source = "ocr";
      if (kind === "block") {
        labels.forEach((item) => {
          item.blockId = "a";
        });
        labels[3].blockId = "b";
      }
      expect(buildLines(labels, true)).toHaveLength(2);
    }
  );

  it.each([
    ["edge field", "Page 1", 520, 1, true],
    ["interior field", "Page 1", 500, 1, false],
    ["multiple lines", "Page 1", 520, 2, false],
    ["shaped field", "עמוד 1", 520, 1, false],
    ["mixed formula fonts", "(11)", 520, 1, false],
    ["long continuation", "continued text", 350, 1, false],
  ])(
    "anchors a terminal %s without changing its text width",
    async (_name, text, x, lines, rightTab) => {
      const raw: RawPage = {
        number: 1,
        width: 600,
        height: 800,
        source: "pdf",
        figures: [],
        rules: [],
        issues: [],
        spans: [
          {
            ...span("Body text establishes the source writing width.", 50, 50),
            width: 500,
          },
          { ...span("Author", 50, 700), width: 60 },
          { ...span("Category", 250, 700), width: 60 },
          { ...span(text, x, 700), width: 30 },
        ],
      };
      if (_name === "mixed formula fonts") raw.spans[2].font = "CMEX10";
      if (_name === "long continuation") raw.spans[3].width = 200;
      const model = analyzeLayout([raw]);
      const paragraph = model.pages[0].groups
        .flatMap((g) => g.columns.flat())
        .find(
          (p) => p.kind === "paragraph" && paragraphText(p).includes("Author")
        )!;
      expect(paragraph.kind).toBe("paragraph");
      if (paragraph.kind !== "paragraph")
        throw new Error("Missing footer line");
      expect(paragraph.runs.at(-1)?.tabBefore).toBe(x);
      paragraph.lineCount = lines;
      const zip = await JSZip.loadAsync(
        await (
          await exportDocx(model, { preservePageBreaks: true })
        ).arrayBuffer()
      );
      const xml = await zip.file("word/document.xml")!.async("string");
      const footer = [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gu)]
        .map((m) => m[0])
        .find((p) => p.includes("Author"))!;
      expect(footer.includes('<w:tab w:val="right"')).toBe(rightTab);
      expect(footer).toContain(text);
      expect(footer).toContain('<w:sz w:val="24"');
      if (rightTab) {
        expect(footer).toContain('<w:tab w:val="right" w:pos="10280"');
        expect(footer).toContain('<w:fitText w:val="600"');
      }
    }
  );
  it("retains source fit widths and font sizes while allowing bounded reader spacing on full mixed lines", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return measureContext();
        }
      }
    );
    try {
      const mixed = "甲1乙2丙3丁4".repeat(8);
      const raw: RawPage = {
        number: 1,
        width: 676,
        height: 842,
        source: "pdf",
        figures: [],
        rules: [],
        issues: [],
        spans: [
          { ...span(mixed, 50, 50), width: 576 },
          { ...span("短1", 50, 90), width: 18 },
        ],
      };
      const zip = await JSZip.loadAsync(
        await (
          await exportDocx(analyzeLayout([raw]), { preservePageBreaks: true })
        ).arrayBuffer()
      );
      const xml = await zip.file("word/document.xml")!.async("string");
      const full = [...xml.matchAll(/<w:r>.*?<\/w:r>/gu)]
        .map((m) => m[0])
        .find((r) => r.includes(mixed))!;
      expect(full).toContain('<w:sz w:val="24"/>');
      expect(
        Number(full.match(/<w:fitText w:val="(\d+)"/u)?.[1])
      ).toBeGreaterThan(11300);
      const scale = Number(full.match(/<w:w w:val="(\d+)"/u)?.[1]);
      expect(scale).toBeGreaterThanOrEqual(90);
      expect(scale).toBeLessThanOrEqual(94);
      const short = [...xml.matchAll(/<w:r>.*?<\/w:r>/gu)]
        .map((m) => m[0])
        .find((r) => r.includes("短1"))!;
      expect(short).not.toContain("<w:w ");
      expect(short).toContain('<w:fitText w:val="360"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
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

it.each(["مرحبا", "עִבְרִית", "हिन्दी", "Mixed עברית 123"])(
  "keeps %s editable without Word fitText splitting shaped glyph clusters",
  async (text) => {
    const raw: RawPage = {
      number: 1,
      width: 600,
      height: 800,
      source: "pdf",
      figures: [],
      rules: [],
      issues: [],
      spans: [
        { ...span(text, 50, 50), font: "Arial", width: 100, size: 18 },
        { ...span("Latin baseline", 50, 100), font: "Arial", width: 100 },
      ],
    };
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(analyzeLayout([raw]), { preservePageBreaks: true })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    const runs = [...xml.matchAll(/<w:r>.*?<\/w:r>/gu)].map((m) => m[0]);
    const complex = runs.find((r) => r.includes(text))!;
    expect(complex).toBeDefined();
    expect(complex).not.toContain("w:fitText");
    expect(complex).toContain('<w:sz w:val="36"/>');
    expect(runs.find((r) => r.includes("Latin baseline"))).toContain(
      "w:fitText"
    );
    expect(xml).not.toContain("w:drawing");
  }
);

it.each([true, false])(
  "keeps explicit tab coordinates even when the last field touches the right edge (preserve lines: %s)",
  (preserve) => {
    const [p] = groupParagraphs(
      buildLines(
        [
          { ...span("Uranus", 470, 148), width: 21, size: 6, height: 6 },
          { ...span("Neptune", 658, 148), width: 24, size: 6, height: 6 },
        ],
        true
      ),
      { x: 40, y: 40, width: 642, height: 520 },
      8,
      preserve
    );
    expect(p.align).toBe("left");
    expect(p.indent).toBe(430);
    expect(p.runs[1]).toMatchObject({ text: "Neptune", tabBefore: 658 });
    expect(paragraphText(p)).toBe("Uranus Neptune");
  }
);
it("retains genuine right alignment for an untabbed short line", () => {
  const [p] = groupParagraphs(
    buildLines(
      [{ ...span("Neptune", 658, 148), width: 24, size: 6, height: 6 }],
      true
    ),
    { x: 40, y: 40, width: 642, height: 520 },
    8
  );
  expect(p.align).toBe("right");
  expect(p.indent).toBe(0);
});

it("does not reinterpret equation-number tabs as ordinary label fields", () => {
  const [p] = groupParagraphs(
    buildLines(
      [
        { ...span("b = c", 470, 148), width: 60, size: 6, height: 6 },
        { ...span("(8)", 658, 148), width: 24, size: 6, height: 6 },
      ],
      true
    ),
    { x: 40, y: 40, width: 642, height: 520 },
    8
  );
  expect(p.align).toBe("right");
  expect(p.indent).toBe(0);
  expect(p.runs[1].tabBefore).toBe(658);
});

it.each(["pdf", "ocr", "reflow"])(
  "exports independent row tab targets for %s text",
  async (mode) => {
    const spans = [
      ["LeftA", 60, 50, 20],
      ["Alpha", 160, 50, 30],
      ["EndA", 460, 50, 30],
      ["LeftB", 60, 66, 20],
      ["Beta", 260, 66, 24],
      ["EndB", 460, 66, 30],
      ["LeftC", 60, 82, 20],
      ["EndC", 460, 82, 30],
    ].map(([text, x, y, width]) => ({
      ...span(String(text), Number(x), Number(y)),
      width: Number(width),
      font: "Courier",
    }));
    const raw: RawPage = {
      number: 1,
      width: 600,
      height: 800,
      source: "pdf",
      spans,
      rules: [],
      figures: [],
      issues: [],
    };
    const model = analyzeLayout([raw]);
    const paragraph = makeParagraph(
      buildLines(spans, true),
      { x: 50, y: 50, width: 500, height: 700 },
      12,
      true
    );
    paragraph.source = mode === "ocr" ? "ocr" : "pdf";
    paragraph.align = "left";
    model.pages[0].margins = { left: 50, right: 50, top: 50, bottom: 50 };
    model.pages[0].groups = [{ columns: [[paragraph]], widths: [500], gap: 0 }];
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: mode !== "reflow" })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    const body = [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gu)]
      .map((m) => m[0])
      .find((p) => p.includes("LeftA"))!;
    expect(body).not.toContain("w:drawing");
    if (mode !== "pdf") {
      // OCR widths and reflowed rows are not reliable positioning evidence.
      expect([...body.matchAll(/<w:tab\/>/gu)]).toHaveLength(5);
      return;
    }
    const stops = [...body.matchAll(/<w:tab w:val="left" w:pos="(\d+)"/gu)].map(
      (m) => Number(m[1]) / 20
    );
    // Independently follow Word's next-stop semantics using the emitted XML.
    const margin = Number(xml.match(/<w:pgMar[^>]*w:left="(\d+)"/u)?.[1]) / 20;
    const indent =
      Number(body.match(/<w:ind[^>]*w:left="(\d+)"/u)?.[1] ?? 0) / 20;
    let cursor = indent;
    const positions: Record<string, number> = {};
    for (const [runXml] of body.matchAll(/<w:r>.*?<\/w:r>/gu)) {
      if (runXml.includes("<w:br")) cursor = indent;
      for (const _tab of runXml.matchAll(/<w:tab\/>/gu))
        cursor = stops.find((stop) => stop > cursor + 0.001)!;
      const text = runXml.match(/<w:t[^>]*>(.*?)<\/w:t>/u)?.[1];
      if (text) {
        positions[text] = cursor + margin;
        cursor += Number(runXml.match(/<w:fitText w:val="(\d+)"/u)?.[1]) / 20;
      }
    }
    expect(positions).toEqual({
      LeftA: 60,
      Alpha: 160,
      EndA: 460,
      LeftB: 60,
      Beta: 260,
      EndB: 460,
      LeftC: 60,
      EndC: 460,
    });
  }
);
it.each(["pdf", "ocr", "proportional"])(
  "records nested line positions only for native monospaced text (%s)",
  (mode) => {
    const spans = [60, 72, 96, 120, 72, 60].map((x, i) => ({
      ...span(`Line${i}`, x, 50 + i * 16),
      width: 30,
      font: mode === "proportional" ? "Arial" : "Courier",
      source: mode === "ocr" ? ("ocr" as const) : ("pdf" as const),
    }));
    const p = makeParagraph(
      buildLines(spans),
      { x: 50, y: 50, width: 500, height: 700 },
      12
    );
    expect(p.runs.map((r) => r.sourceLineX)).toEqual(
      mode === "pdf" ? [60, 72, 96, 120, 72, 60] : Array(6).fill(undefined)
    );
    expect(p.lineCount).toBe(6);
  }
);

it.each([true, false])(
  "exports nested code at each source indent without changing reflow (preserve: %s)",
  async (preserve) => {
    const positions = [60, 72, 96, 120, 72, 60];
    const spans = positions.map((x, i) => ({
      ...span(`Line${i}`, x, 50 + i * 16),
      width: 30,
      font: "Courier",
    }));
    const raw: RawPage = {
      number: 1,
      width: 600,
      height: 800,
      source: "pdf",
      spans,
      rules: [],
      figures: [],
      issues: [],
    };
    const model = analyzeLayout([raw]);
    const paragraph = makeParagraph(
      buildLines(spans),
      { x: 50, y: 50, width: 500, height: 700 },
      12
    );
    model.pages[0].margins = { left: 50, right: 50, top: 50, bottom: 50 };
    model.pages[0].groups = [{ columns: [[paragraph]], widths: [500], gap: 0 }];
    const original = structuredClone(model);
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: preserve })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    const body = [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gu)]
      .map((m) => m[0])
      .find((p) => p.includes("Line0"))!;
    expect(model).toEqual(original);
    expect(body).not.toContain("w:drawing");
    if (!preserve) {
      expect(body).not.toContain("<w:tab");
      expect(body).not.toContain("<w:br");
      return;
    }
    const stops = [...body.matchAll(/<w:tab w:val="left" w:pos="(\d+)"/gu)].map(
      (m) => Number(m[1]) / 20
    );
    const margin = Number(xml.match(/<w:pgMar[^>]*w:left="(\d+)"/u)?.[1]) / 20;
    const indent =
      Number(body.match(/<w:ind[^>]*w:left="(\d+)"/u)?.[1] ?? 0) / 20;
    let cursor = indent;
    const actual: number[] = [];
    for (const [runXml] of body.matchAll(/<w:r>.*?<\/w:r>/gu)) {
      if (runXml.includes("<w:br")) cursor = indent;
      for (const _tab of runXml.matchAll(/<w:tab\/>/gu))
        cursor = stops.find((s) => s > cursor + 0.001)!;
      if (/<w:t[ >]/u.test(runXml)) {
        actual.push(cursor + margin);
        cursor += Number(runXml.match(/<w:fitText w:val="(\d+)"/u)?.[1]) / 20;
      }
    }
    expect(actual).toEqual(positions);
    expect([...body.matchAll(/<w:br\/>/gu)]).toHaveLength(5);
  }
);
it.each(["native", "ocr", "proportional", "combined"])(
  "requires separate native monospaced label geometry (%s)",
  (mode) => {
    const items =
      mode === "combined"
        ? [
            {
              ...span("3. Header", 80, 50),
              width: 60,
              font: "Courier",
              size: 10,
            },
          ]
        : [
            {
              ...span("3.", 80, 50),
              width: 12,
              font: mode === "proportional" ? "Arial" : "Courier",
              size: 10,
              source: mode === "ocr" ? ("ocr" as const) : ("pdf" as const),
            },
            {
              ...span("Header", 104, 50),
              width: 36,
              font: mode === "proportional" ? "Arial" : "Courier",
              size: 10,
              source: mode === "ocr" ? ("ocr" as const) : ("pdf" as const),
            },
          ];
    const p = makeParagraph(
      buildLines(items),
      { x: 80, y: 50, width: 400, height: 700 },
      10
    );
    expect(p.listMarkerWidth).toBe(mode === "native" ? 24 : undefined);
    expect(paragraphText(p)).toBe("3. Header");
  }
);

it.each([true, false])(
  "preserves measured native label and body widths only in source layout (%s)",
  async (preserve) => {
    const raw: RawPage = {
      number: 1,
      width: 600,
      height: 800,
      source: "pdf",
      figures: [],
      rules: [],
      issues: [],
      spans: [
        { ...span("3.", 80, 50), width: 12, font: "Courier", size: 10 },
        { ...span("Header", 104, 50), width: 36, font: "Courier", size: 10 },
      ],
    };
    const model = analyzeLayout([raw]);
    const original = structuredClone(model);
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: preserve })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    const numbering = await zip.file("word/numbering.xml")!.async("string");
    const body = [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gu)]
      .map((m) => m[0])
      .find((p) => p.includes("Header"))!;
    expect(body).toContain("<w:numPr>");
    expect(body).not.toContain("w:drawing");
    expect(model).toEqual(original);
    if (!preserve) {
      expect(numbering).not.toContain('w:ascii="Courier New"');
      return;
    }
    const margin = Number(xml.match(/<w:pgMar[^>]*w:left="(\d+)"/u)?.[1]) / 20;
    const indent = Number(body.match(/<w:ind[^>]*w:left="(\d+)"/u)?.[1]) / 20;
    expect(margin + indent).toBe(104);
    expect(body).toContain('w:hanging="480"');
    expect(body).toContain('<w:fitText w:val="720"');
    const level = [
      ...numbering.matchAll(/<w:abstractNum\b.*?<\/w:abstractNum>/gu),
    ]
      .map((m) => m[0])
      .find((s) => s.includes('w:val="%1."'))!;
    expect(level).toContain('w:ascii="Courier New"');
    expect(level).toContain('<w:sz w:val="20"/>');
  }
);

it("does not reuse a measured numbering font size for a differently sized next item", async () => {
  const raw: RawPage = {
    number: 1,
    width: 600,
    height: 800,
    source: "pdf",
    figures: [],
    rules: [],
    issues: [],
    spans: [
      { ...span("1.", 80, 50), width: 12, font: "Courier", size: 10 },
      { ...span("First", 104, 50), width: 30, font: "Courier", size: 10 },
      { ...span("2.", 80, 100), width: 14.4, font: "Courier", size: 12 },
      { ...span("Second", 108.8, 100), width: 43.2, font: "Courier", size: 12 },
    ],
  };
  const zip = await JSZip.loadAsync(
    await (
      await exportDocx(analyzeLayout([raw]), { preservePageBreaks: true })
    ).arrayBuffer()
  );
  const numbering = await zip.file("word/numbering.xml")!.async("string");
  const levels = [
    ...numbering.matchAll(/<w:abstractNum\b.*?<\/w:abstractNum>/gu),
  ]
    .map((m) => m[0])
    .filter((s) => s.includes('w:ascii="Courier New"'));
  expect(levels).toHaveLength(2);
  expect(levels[0]).toContain('<w:sz w:val="20"/>');
  expect(levels[1]).toContain('<w:sz w:val="24"/>');
});
