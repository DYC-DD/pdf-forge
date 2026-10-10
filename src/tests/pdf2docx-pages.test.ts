import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import {
  applyPageSetup,
  detectPageSetups,
  MARGIN_PRESETS,
  PAPER_SIZES,
} from "../features/pdf2docx/lib/pageSetup";
import {
  buildLines,
  groupParagraphs,
  paragraphText,
} from "../features/pdf2docx/lib/paragraphs";
import type {
  ExportOptions,
  Figure,
  RawPage,
  TextSpan,
} from "../features/pdf2docx/types";

let id = 0;
function span(
  text: string,
  x: number,
  y: number,
  width = 180,
  extra: Partial<TextSpan> = {}
): TextSpan {
  return {
    id: `test-${id++}`,
    text,
    x,
    y,
    width,
    height: 12,
    baseline: y + 10,
    size: 12,
    font: "Arial",
    bold: false,
    italic: false,
    source: "pdf",
    ...extra,
  };
}
function page(spans: TextSpan[], figures: Figure[] = []): RawPage {
  return {
    number: 1,
    width: 600,
    height: 800,
    source: "pdf",
    spans,
    figures,
    rules: [],
    issues: [],
  };
}
function figure(
  x: number,
  y: number,
  width = 100,
  height = 70,
  color = "#3268b0"
): Figure {
  const canvas = createCanvas(width * 2, height * 2),
    context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "white";
  context.font = "24px Arial";
  context.fillText("Figure", 16, 40);
  return {
    id: `image-${id++}`,
    x,
    y,
    width,
    height,
    data: new Uint8Array(canvas.toBuffer("image/png")),
  };
}
function marginPage(source: RawPage, preset: "narrow" | "standard"): RawPage {
  const margins = MARGIN_PRESETS[preset];
  const factor = (source.width - margins.left - margins.right) / 500;
  return {
    ...source,
    spans: source.spans.map((span) => ({
      ...span,
      x: margins.left + (span.x - 50) * factor,
      y: margins.top + span.y - 50,
      baseline: margins.top + span.baseline - 50,
      width: span.width * factor,
    })),
    figures: source.figures.map((image) => ({
      ...image,
      x: margins.left + (image.x - 50) * factor,
      y: margins.top + image.y - 50,
      width: image.width * factor,
      height: image.height * factor,
    })),
  };
}
async function document(
  raw: RawPage[],
  options: ExportOptions = { preservePageBreaks: false },
  qaName?: string
) {
  const model = analyzeLayout(raw);
  const blob = await exportDocx(model, options);
  if (qaName && process.env.PDF2DOCX_QA_DIR) {
    await mkdir(process.env.PDF2DOCX_QA_DIR, { recursive: true });
    await writeFile(
      resolve(process.env.PDF2DOCX_QA_DIR, `${qaName}.docx`),
      new Uint8Array(await blob.arrayBuffer())
    );
  }
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return { model, xml: await zip.file("word/document.xml")!.async("string") };
}

describe("PDF2docx standard page setup", () => {
  it("keeps clearance below a table that nearly touches a common bottom margin", () => {
    const raw = page([span("A", 40, 45, 20), span("B", 300, 45, 20)]);
    raw.width = 842;
    raw.height = 595;
    raw.rules = [36, 70, 558]
      .map((y) => ({ x1: 36, x2: 806, y1: y, y2: y }))
      .concat([36, 280, 806].map((x) => ({ x1: x, x2: x, y1: 36, y2: 558 })));
    const model = analyzeLayout([raw]);
    const setup = detectPageSetups(model.pages)[0];
    expect(setup.margins.bottom).toBeLessThan(36);
    const mapped = applyPageSetup(model.pages[0], setup);
    expect(mapped.groups[0].columns[0][0].y).toBeCloseTo(36, 1);
    expect(mapped.height - setup.margins.bottom).toBeGreaterThan(558);
  });
  it("automatically recognizes rounded A4 and shares narrow margins with a sparse page", async () => {
    const one = {
      ...page([
        span("Full first line continues", 36, 36, 520),
        span("Second full line continues", 36, 52, 520),
      ]),
      width: 595,
      height: 842,
    };
    const two = {
      ...page([span("Short indented last page", 120, 100)]),
      width: 595,
      height: 842,
      number: 2,
    };
    const result = await document([one, two], { preservePageBreaks: true });
    const sizes = result.xml.match(/<w:pgSz[^>]+>/g)!;
    expect(sizes).toHaveLength(2);
    expect(new Set(sizes)).toEqual(
      new Set(['<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>'])
    );
    expect(
      result.xml.match(
        /<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/g
      )
    ).toHaveLength(2);
  });
  it.each([
    ["a3", 16838, 23811],
    ["a5", 8391, 11906],
    ["letter", 12240, 15840],
    ["source", 12000, 16000],
  ] as const)(
    "automatically recognizes %s and standard margins from content",
    async (paperSize, width, height) => {
      const size =
        paperSize === "source"
          ? { width: 600, height: 800 }
          : PAPER_SIZES[paperSize];
      const { xml } = await document([
        { ...page([span("Standard page", 90, 72, 180)]), ...size },
      ]);
      expect(xml).toContain(
        `<w:pgSz w:w="${width}" w:h="${height}" w:orient="portrait"/>`
      );
      expect(xml).toContain(
        '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"'
      );
    }
  );
  it("follows source orientation and fits images without enlarging or distortion", () => {
    const model = analyzeLayout([
      {
        ...page(
          [span("Text remains 12 pt", 90, 72)],
          [figure(90, 100, 450, 600)]
        ),
        width: PAPER_SIZES.a5.height,
        height: PAPER_SIZES.a5.width,
      },
    ]);
    const source = structuredClone(model.pages[0]);
    const mapped = applyPageSetup(model.pages[0]);
    expect(mapped.width).toBeGreaterThan(mapped.height);
    const blocks = mapped.groups.flatMap((group) => group.columns.flat());
    const image = blocks.find((block) => block.kind === "image")!;
    expect(image.width / image.height).toBeCloseTo(450 / 600);
    expect(image.height).toBeLessThanOrEqual(
      mapped.height - mapped.margins.top - mapped.margins.bottom - 24
    );
    const text = blocks.find((block) => block.kind === "paragraph")!;
    expect(text.runs[0].size).toBe(12);
    expect(model.pages[0]).toEqual(source);
  });
  it("preserves custom physical sizes instead of guessing A4 from aspect ratio", () => {
    const source = {
      ...page([span("Small cropped page", 36, 36)]),
      width: 210,
      height: 297,
    };
    expect(detectPageSetups(analyzeLayout([source]).pages)[0]).toMatchObject({
      paperSize: "source",
      width: 210,
      height: 297,
    });
  });
  it("does not mistake short lines or empty pages for large right or bottom margins", () => {
    const first = page([span("Short paragraph", 90, 72, 100)]);
    const blank = { ...page([]), number: 2 };
    const setups = detectPageSetups(analyzeLayout([first, blank]).pages);
    expect(setups.map((setup) => setup.margins)).toEqual([
      MARGIN_PRESETS.standard,
      MARGIN_PRESETS.standard,
    ]);
  });
  it("preserves supported custom margins when neither common preset fits", () => {
    const model = analyzeLayout([
      page([
        span("A long line in a custom writing area", 12, 12, 576),
        span("A second long line in the same area", 12, 28, 576),
      ]),
    ]);
    expect(detectPageSetups(model.pages)[0]).toMatchObject({
      marginPreset: "detected",
      margins: { left: 12, right: 12, top: 12 },
    });
  });
  it("keeps A4 portrait and A3 landscape in separate source sections", async () => {
    const one = { ...page([span("A4 portrait", 90, 72)]), ...PAPER_SIZES.a4 };
    const two = {
      ...page([span("A3 landscape", 36, 36)]),
      number: 2,
      width: PAPER_SIZES.a3.height,
      height: PAPER_SIZES.a3.width,
    };
    const result = await document([one, two]);
    expect(result.xml).toContain(
      '<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>'
    );
    expect(result.xml).toContain(
      '<w:pgSz w:w="23811" w:h="16838" w:orient="landscape"/>'
    );
  });
});

describe("PDF2docx image arrangement and OCR reading order", () => {
  it.each(["narrow", "standard"] as const)(
    "keeps side-by-side pictures in a single borderless native table row with %s margins",
    async (margins) => {
      const { model, xml } = await document(
        [
          marginPage(
            page(
              [
                span("Two figures on one row", 50, 50, 400, {
                  size: 18,
                  bold: true,
                }),
                span(
                  "Both pictures stay together above this editable paragraph.",
                  50,
                  210,
                  480
                ),
              ],
              [figure(50, 100, 160, 80), figure(260, 100, 160, 80, "#b05532")]
            ),
            margins
          ),
        ],
        { preservePageBreaks: false },
        `image-row-${margins}`
      );
      expect(model.stats.images).toBe(2);
      expect(detectPageSetups(model.pages)[0].marginPreset).toBe(margins);
      expect(model.stats.tables).toBe(0);
      expect(
        model.pages[0].groups[0].columns[0].some(
          (block) => block.kind === "image-row"
        )
      ).toBe(true);
      expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
      expect(xml.match(/<w:tr[ >]/g)).toHaveLength(1);
      expect(xml).toContain('w:val="none"');
      expect(xml).not.toContain("txbxContent");
    }
  );
  it.each(["narrow", "standard"] as const)(
    "attaches a side picture to editable text with %s margins",
    async (margins) => {
      const { model, xml } = await document(
        [
          marginPage(
            page(
              [
                span("A picture beside editable text", 50, 50, 460, {
                  size: 18,
                  bold: true,
                }),
                span("This paragraph wraps around the photo", 180, 100, 350),
                span("and keeps its reading order as ordinary", 180, 116, 350),
                span("editable text in the Word document.", 180, 132, 350),
                span(
                  "The following paragraph remains below the picture.",
                  50,
                  210,
                  480
                ),
              ],
              [figure(50, 100, 110, 80)]
            ),
            margins
          ),
        ],
        { preservePageBreaks: false },
        `image-wrap-${margins}`
      );
      expect(model.stats.images).toBe(1);
      expect(detectPageSetups(model.pages)[0].marginPreset).toBe(margins);
      const paragraph = model.pages[0].groups
        .flatMap((group) => group.columns.flat())
        .find(
          (block) => block.kind === "paragraph" && block.floatingImages?.length
        );
      expect(paragraph?.kind === "paragraph" && paragraph.indent).toBe(0);
      expect(xml).toContain("<wp:anchor");
      expect(xml).toContain("<wp:wrapSquare");
      expect(xml).not.toContain("txbxContent");
      expect(xml.indexOf("editable text in the Word document.")).toBeLessThan(
        xml.indexOf("The following paragraph")
      );
    }
  );
  it("reads a short two-column region column by column instead of interleaving rows", () => {
    const model = analyzeLayout([
      page([
        span("Left first", 50, 100, 180),
        span("Right first", 310, 100, 240),
        span("Left second", 50, 116, 180),
        span("Right second", 310, 116, 240),
      ]),
    ]);
    const group = model.pages[0].groups[0];
    expect(group.columns).toHaveLength(2);
    expect(
      group.columns[0]
        .filter((block) => block.kind === "paragraph")
        .map(paragraphText)
        .join(" ")
    ).toBe("Left first Left second");
  });
  it("honors OCR block and paragraph boundaries at similar coordinates", () => {
    const spans = [
      span("First OCR paragraph", 50, 100, 180, {
        blockId: "a",
        paragraphId: "a1",
      }),
      span("Second OCR paragraph", 50, 116, 180, {
        blockId: "a",
        paragraphId: "a2",
      }),
      span("Separate OCR block", 250, 100, 180, {
        blockId: "b",
        paragraphId: "b1",
      }),
    ];
    const lines = buildLines(spans);
    expect(lines).toHaveLength(3);
    const first = groupParagraphs(
      lines.filter((line) => line.spans[0].blockId === "a"),
      { x: 50, y: 100, width: 400, height: 100 },
      12
    );
    expect(first.map(paragraphText)).toEqual([
      "First OCR paragraph",
      "Second OCR paragraph",
    ]);
  });
});
