import { createRequire } from "node:module";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import JSZip from "jszip";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { figureRegions } from "../features/pdf2docx/lib/extractPage";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { detectPageSetups } from "../features/pdf2docx/lib/pageSetup";
import { buildLines, lineRuns } from "../features/pdf2docx/lib/paragraphs";
import {
  editableScanLines,
  retainUncertainScan,
} from "../features/pdf2docx/lib/scanFallback";
import { createScanFontMatcher } from "../features/pdf2docx/lib/scanFont";
import { normalizeOversizedScan } from "../features/pdf2docx/lib/scanPageSize";
import type { RawPage, TextSpan } from "../features/pdf2docx/types";

const span = (
  text: string,
  x: number,
  y: number,
  extra: Partial<TextSpan> = {}
): TextSpan => ({
  id: `${text}:${x}:${y}`,
  text,
  x,
  y,
  width: 180,
  height: 12,
  baseline: y + 10,
  size: 12,
  font: "Arial",
  bold: false,
  italic: false,
  source: "pdf",
  ...extra,
});
const page = (spans: TextSpan[]): RawPage => ({
  number: 1,
  width: 600,
  height: 800,
  spans,
  rules: [],
  figures: [],
  issues: [],
  source: "pdf",
});
const blocks = (raw: RawPage) =>
  analyzeLayout([raw]).pages[0].groups.flatMap((group) => group.columns.flat());

describe("mixed artwork and dense source page fidelity", () => {
  it("keeps a logo beside an editable table without stacking their heights", () => {
    const raw = page([
      span("A", 330, 55, { width: 10 }),
      span("B", 440, 55, { width: 10 }),
      span("C", 330, 75, { width: 10 }),
      span("D", 440, 75, { width: 10 }),
      span("Body below", 50, 120),
    ]);
    raw.figures = [
      {
        id: "logo",
        x: 40,
        y: 50,
        width: 190,
        height: 40,
        data: new Uint8Array(),
      },
    ];
    raw.rules = [
      ...[50, 70, 90].map((y) => ({ x1: 325, x2: 555, y1: y, y2: y })),
      ...[325, 435, 555].map((x) => ({ x1: x, x2: x, y1: 50, y2: 90 })),
    ];
    const model = analyzeLayout([raw]);
    expect(model.stats.tables).toBe(1);
    expect(model.stats.images).toBe(1);
    expect(model.pages[0].overlays?.map((f) => f.id)).toEqual(["logo"]);
    expect(blocks(raw).some((b) => b.kind === "image")).toBe(false);
    raw.spans.push(span("Intervening text", 240, 60, { width: 70 }));
    expect(analyzeLayout([raw]).pages[0].overlays).toHaveLength(0);
  });
  it("keeps aligned OCR crops and logos on one row despite form rules, without swallowing intervening text", () => {
    const raw = page([span("Body below", 50, 120)]);
    raw.figures = [
      {
        id: "logo",
        x: 40,
        y: 50,
        width: 190,
        height: 40,
        data: new Uint8Array(),
      },
      {
        id: "crop",
        x: 325,
        y: 49,
        width: 230,
        height: 39,
        data: new Uint8Array(),
        role: "scan-region",
      },
    ];
    raw.rules = [{ x1: 325, x2: 555, y1: 77, y2: 77, thickness: 0.5 }];
    const result = blocks(raw);
    expect(result.filter((b) => b.kind === "image-row")).toHaveLength(1);
    expect(result.some((b) => b.kind === "rule")).toBe(true);
    raw.spans.push(span("Field", 245, 60, { width: 60 }));
    expect(blocks(raw).some((b) => b.kind === "image-row")).toBe(false);
  });
  it("does not merge an edge stamp and a touching thin address strip into an opaque page-wide rectangle", () => {
    const boxes = [
      { x: 0, y: 390, width: 40, height: 120 },
      { x: 20, y: 405, width: 580, height: 14 },
    ];
    expect(figureRegions(boxes, 600, 800, true)).toEqual(boxes);
    // Contiguous rectangular tiles still need a single image.
    expect(
      figureRegions(
        [
          { x: 20, y: 30, width: 50, height: 50 },
          { x: 69, y: 30, width: 50, height: 50 },
        ],
        600,
        800,
        true
      )
    ).toHaveLength(1);
  });
  it("anchors marginal stamps without adding their height to body flow", () => {
    const raw = page([span("Body", 60, 60), span("Later", 60, 600)]);
    raw.figures.push({
      id: "edge-stamp",
      x: 560,
      y: 500,
      width: 40,
      height: 120,
      data: new Uint8Array(),
    });
    const result = analyzeLayout([raw]);
    expect(result.pages[0].overlays).toHaveLength(1);
    expect(blocks(raw).every((block) => block.kind === "paragraph")).toBe(true);
  });
  it("uses the next row's distance instead of accumulating guessed single-line leading", () => {
    const raw = page([
      span("One.", 50, 50),
      span("Two.", 50, 62),
      span("Three.", 50, 74),
    ]);
    const paragraphs = blocks(raw).filter(
      (block) => block.kind === "paragraph"
    );
    expect(paragraphs).toHaveLength(3);
    expect(
      paragraphs.slice(0, 2).map((paragraph) => paragraph.lineHeight)
    ).toEqual([12, 12]);
  });
  it("keeps form field pairs on shared rows instead of creating narrow Word columns", () => {
    const raw = page([
      span("A full width document header", 50, 30, { width: 500 }),
      span("Date", 50, 70, { width: 120 }),
      span("Reason", 350, 70, { width: 120 }),
      span("Name", 50, 82, { width: 480 }),
      span("Level", 50, 94, { width: 60 }),
      span("Area", 350, 94, { width: 120 }),
      span("Floor", 50, 106, { width: 60 }),
      span("Total", 350, 106, { width: 120 }),
      span("Address", 50, 118, { width: 480 }),
    ]);
    expect(
      analyzeLayout([raw]).pages[0].groups.map((group) => group.columns.length)
    ).toEqual([1]);
  });
  it("reserves bottom space for a centered continuation marker", () => {
    const raw = page([
      span("Dense body", 20, 20, { width: 540 }),
      span("Last body", 20, 760, { width: 540 }),
      span("Continued", 255, 781, { width: 90 }),
    ]);
    const model = analyzeLayout([raw]);
    expect(detectPageSetups(model.pages)[0].margins.bottom).toBeLessThanOrEqual(
      4
    );
  });
  it("preserves a narrow gutter on long rows once surrounding prose establishes columns", () => {
    const raw = page(
      [0, 1, 2, 3].flatMap((row) => [
        span("Left column entry", 30, 50 + row * 20, {
          width: row === 2 ? 270 : 240,
        }),
        span("Right column entry", 325, 50 + row * 20, { width: 245 }),
      ])
    );
    const groups = analyzeLayout([raw]).pages[0].groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].columns).toHaveLength(2);
    expect(
      groups[0].columns[0]
        .filter((block) => block.kind === "paragraph")
        .flatMap((block) => block.runs)
        .every((run) => !run.text.includes("Right"))
    ).toBe(true);
  });
  it("preserves explicit spaces between Chinese source spans", () => {
    const line = buildLines([
      span("設計", 30, 50, { width: 24, spaceAfter: true }),
      span("公司", 58, 50, { width: 24 }),
    ])[0];
    expect(
      lineRuns(line)
        .map((run) => run.text)
        .join("")
    ).toBe("設計 公司");
  });
  it("keeps widely spaced long prose in independent reading columns", () => {
    const raw = page(
      [0, 1, 2].flatMap((row) => [
        span("Left column long chronological entry.", 30, 50 + row * 36, {
          width: 245,
        }),
        span("Right column long chronological entry.", 325, 50 + row * 36, {
          width: 245,
        }),
      ])
    );
    expect(
      analyzeLayout([raw]).pages[0].groups.some(
        (group) => group.columns.length === 2
      )
    ).toBe(true);
  });
  it("preserves Chinese list line boundaries when no Word numbering replaces the marker", async () => {
    const model = analyzeLayout([
      page([
        span("二、這是同一個條款的第一行", 50, 50, { width: 450 }),
        span("第二行內容", 74, 66, { width: 150 }),
      ]),
    ]);
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: true })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toMatch(/<w:br\/><w:t[^>]*>第二行內容/);
  });
});

describe("scan region fidelity", () => {
  beforeAll(() => {
    // Ubuntu has no Arial. Load PDF.js's bundled fonts for the fixture and both
    // generic fallback probes so matching never depends on system fonts.
    const require = createRequire(import.meta.url);
    const fonts = [
      ["LiberationSans-Regular.ttf", "Arial"],
      ["FoxitSerif.pfb", "serif"],
      ["FoxitFixed.pfb", "monospace"],
    ].map(([file, family]) => {
      const font = GlobalFonts.registerFromPath(
        require.resolve(`pdfjs-dist/standard_fonts/${file}`),
        family
      );
      if (!font)
        throw new Error(`Unable to register scan fixture font: ${file}`);
      return font;
    });
    return () => {
      GlobalFonts.removeBatch(fonts);
    };
  });
  afterEach(() => vi.unstubAllGlobals());
  const fixture = () => {
    const canvas = createCanvas(600, 800),
      context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 600, 800);
    context.fillStyle = "black";
    context.fillRect(52, 52, 5, 5);
    context.fillRect(52, 102, 5, 5);
    const raw = page([
      span("Reliable row", 50, 50, { source: "ocr", confidence: 98 }),
      span("Uncertain guess", 50, 100, { source: "ocr", confidence: 48 }),
    ]);
    raw.source = "ocr";
    Object.assign(canvas, {
      toBlob: (callback: (blob: Blob) => void) =>
        callback(
          new Blob([new Uint8Array(canvas.toBuffer("image/jpeg"))], {
            type: "image/jpeg",
          })
        ),
    });
    return {
      canvas,
      context,
      raw,
      original: context.getImageData(0, 0, 600, 800),
    };
  };
  it("rejects low-confidence, colored, overlapping and grid-bound text for native replacement", () => {
    const { raw, original, context } = fixture();
    expect(
      editableScanLines(raw, original, 1)
        .flat()
        .map((span) => span.text)
    ).toEqual(["Reliable row"]);
    context.fillStyle = "#8899cc";
    context.fillRect(80, 50, 100, 12);
    expect(
      editableScanLines(raw, context.getImageData(0, 0, 600, 800), 1)
    ).toEqual([]);
    raw.rules = [{ x1: 50, x2: 230, y1: 62, y2: 62 }];
    expect(editableScanLines(raw, original, 1)).toEqual([]);
    raw.rules = [];
    raw.spans.push(
      span("Overlapping", 230, 55, {
        source: "ocr",
        confidence: 98,
        lineId: "other",
        baseline: 65,
      })
    );
    expect(editableScanLines(raw, original, 1)).toEqual([]);
  });
  it("retains uncertain ink and unrecognized artwork once, with reliable text still editable", async () => {
    const { raw, canvas, context } = fixture();
    vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
    context.fillStyle = "white";
    context.fillRect(50, 50, 180, 12);
    context.font = "12px Arial";
    context.fillStyle = "black";
    context.fillText("Reliable row", 50, 60);
    const metrics = context.measureText("Reliable row");
    Object.assign(raw.spans[0], {
      width: metrics.width,
      y: 60 - metrics.actualBoundingBoxAscent,
      height:
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    });
    const original = context.getImageData(0, 0, 600, 800);
    await retainUncertainScan(
      canvas as unknown as HTMLCanvasElement,
      original as unknown as ImageData,
      1,
      raw
    );
    expect(context.getImageData(53, 53, 1, 1).data[0]).toBe(255);
    expect(context.getImageData(53, 103, 1, 1).data[0]).toBe(0);
    expect(raw.spans.map((span) => span.rasterized)).toEqual([false, true]);
    const model = analyzeLayout([raw]);
    expect(model.stats.images).toBe(1);
    expect(model.issues.some((issue) => issue.severity === "error")).toBe(
      false
    );
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: true })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Reliable row");
    expect(xml).not.toContain("Uncertain guess");
    expect(xml.match(/<wp:anchor /g)).toHaveLength(1);
    expect(xml).not.toContain("w:txbxContent");
  });
  it("keeps an entire row when OCR omitted ink at the end", () => {
    const { raw, context } = fixture();
    context.fillRect(250, 52, 10, 8);
    expect(
      editableScanLines(raw, context.getImageData(0, 0, 600, 800), 1)
    ).toEqual([]);
  });
  it("keeps paragraphs atomic when using the original page as a background", async () => {
    const { raw, canvas, context } = fixture();
    vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
    context.fillStyle = "white";
    context.fillRect(0, 0, 600, 800);
    context.font = "12px Arial";
    context.fillStyle = "black";
    raw.spans = [60, 78, 96, 170].map((baseline, index) => {
      const text =
        index < 3
          ? "A reliable paragraph continues"
          : "Separate reliable paragraph.";
      context.fillText(text, 50, baseline);
      const metrics = context.measureText(text);
      return span(text, 50, baseline - metrics.actualBoundingBoxAscent, {
        id: `paragraph-${index}`,
        source: "ocr",
        confidence: index === 1 ? 48 : 98,
        baseline,
        width: metrics.width,
        height:
          metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
      });
    });
    const original = context.getImageData(0, 0, 600, 800);
    expect(createScanFontMatcher(original, 1)([raw.spans[0]])).toBeTruthy();
    await retainUncertainScan(
      canvas as unknown as HTMLCanvasElement,
      original as unknown as ImageData,
      1,
      raw
    );
    expect(raw.spans.map((s) => s.rasterized)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(raw.figures).toHaveLength(1);
  });
  it("keeps visibly different glyphs and missing fonts as original pixels", () => {
    const { raw, context } = fixture();
    vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
    const matcher = createScanFontMatcher(
      context.getImageData(0, 0, 600, 800),
      1
    );
    // Rectangles cannot be replaced by the confident but incorrect OCR text.
    expect(matcher([raw.spans[0]])).toBeUndefined();
  });
  it("retains a scanned page even when no words can be recognized", async () => {
    const { raw, canvas, original } = fixture();
    raw.spans = [];
    await retainUncertainScan(
      canvas as unknown as HTMLCanvasElement,
      original as unknown as ImageData,
      1,
      raw
    );
    const model = analyzeLayout([raw]);
    expect(model.stats.characters).toBe(0);
    expect(model.stats.images).toBe(1);
    await expect(
      exportDocx(model, { preservePageBreaks: true })
    ).resolves.toBeInstanceOf(Blob);
    const second = structuredClone(raw);
    second.number = 2;
    const reflow = await exportDocx(analyzeLayout([raw, second]), {
      preservePageBreaks: false,
    });
    const zip = await JSZip.loadAsync(await reflow.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml.match(/<w:type w:val="nextPage"/g)).toHaveLength(2);
  });
  it("scales oversized scan coordinates and type together without changing normal or native pages", () => {
    const { raw } = fixture();
    const copy = structuredClone(raw);
    normalizeOversizedScan(raw);
    expect(raw).toEqual(copy);
    raw.width = 1800;
    raw.height = 2600;
    raw.figures.push({
      id: "scan",
      x: 0,
      y: 0,
      width: 1800,
      height: 2600,
      data: new Uint8Array(),
    });
    raw.rules.push({ x1: 100, y1: 200, x2: 500, y2: 200, thickness: 3 });
    const native = structuredClone(raw);
    native.source = "pdf";
    normalizeOversizedScan(native);
    expect(native.height).toBe(2600);
    normalizeOversizedScan(raw);
    const factor = raw.height / 2600;
    expect(raw.height).toBeCloseTo(841.89, 2);
    expect(raw.width / raw.height).toBeCloseTo(1800 / 2600);
    expect(raw.spans[0].size).toBeCloseTo(12 * factor);
    expect(raw.spans[0].baseline).toBeCloseTo(60 * factor);
    expect(raw.figures[0].height).toBe(raw.height);
    expect(raw.rules[0].thickness).toBeCloseTo(3 * factor);
  });
});
