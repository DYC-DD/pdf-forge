import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  retainEditableScan,
  scanColorRegions,
} from "../features/pdf2docx/lib/editableScan";
import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { deskewScan, scanSkew } from "../features/pdf2docx/lib/scanDeskew";
import { scanGraphics } from "../features/pdf2docx/lib/scanGraphics";
import { scanRules } from "../features/pdf2docx/lib/scanRules";
import type { RawPage, TextSpan } from "../features/pdf2docx/types";

function canvas(width = 600, height = 800) {
  const result = createCanvas(width, height);
  Object.assign(result, {
    toBlob: (callback: (blob: Blob) => void, mime = "image/png") =>
      callback(
        new Blob([new Uint8Array(result.toBuffer(mime as "image/png"))], {
          type: mime,
        })
      ),
  });
  return result;
}
function fixture() {
  const image = canvas(),
    context = image.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 600, 800);
  const page: RawPage = {
    number: 1,
    width: 600,
    height: 800,
    source: "ocr",
    spans: [],
    rules: [],
    figures: [],
    issues: [],
  };
  const text = (
    value: string,
    x: number,
    y: number,
    extra: Partial<TextSpan> = {}
  ) => {
    context.font = "12px Arial";
    context.fillStyle = extra.color ? `#${extra.color}` : "black";
    context.fillText(value, x, y + 12);
    page.spans.push({
      id: `${page.spans.length}`,
      text: value,
      x,
      y,
      width: context.measureText(value).width,
      height: 14,
      baseline: y + 12,
      size: 12,
      source: "ocr",
      font: "Unavailable scanned font",
      bold: false,
      italic: false,
      confidence: 95,
      ...extra,
    });
  };
  const convert = () =>
    retainEditableScan(
      image as unknown as HTMLCanvasElement,
      context.getImageData(0, 0, 600, 800) as unknown as ImageData,
      1,
      page
    );
  return { image, context, page, text, convert };
}
beforeEach(() =>
  vi.stubGlobal("document", { createElement: () => canvas(1, 1) })
);
afterEach(() => vi.unstubAllGlobals());

it("keeps confident text editable even when the original scan font is unavailable", async () => {
  const f = fixture();
  f.text("Review this readable number: 12345", 50, 50);
  await f.convert();
  const model = analyzeLayout([f.page]);
  expect(model.stats.characters).toBeGreaterThan(25);
  expect(model.stats.images).toBe(0);
  expect(f.page.spans.every((span) => !span.rasterized)).toBe(true);
  const zip = await JSZip.loadAsync(
    await (await exportDocx(model, { preservePageBreaks: true })).arrayBuffer()
  );
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).toContain("12345");
  expect(xml).not.toMatch(/w:vanish|w:txbxContent|<w:drawing>/u);
});

it("preserves an uncertain row as a local crop while keeping reliable surrounding text editable", async () => {
  const f = fixture();
  f.text("Reliable first row", 50, 50);
  f.text("Uncertain value 12345", 50, 100, { confidence: 62 });
  f.text("Reliable final row", 50, 150);
  await f.convert();
  expect(f.page.spans.map((s) => !!s.rasterized)).toEqual([false, true, false]);
  expect(f.page.figures).toHaveLength(1);
  expect(f.page.figures[0].role).toBe("scan-region");
  expect(f.page.figures[0].height).toBeLessThan(25);
  const model = analyzeLayout([f.page]);
  const zip = await JSZip.loadAsync(
    await (await exportDocx(model, { preservePageBreaks: true })).arrayBuffer()
  );
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).toContain("Reliable first row");
  expect(xml).not.toContain("Uncertain value");
  expect(xml).toContain("Reliable final row");
  expect(xml.match(/<w:drawing>/gu)).toHaveLength(1);
  // Keep the crop attached to a flowing paragraph without the inline baseline
  // that added blank pages, or an exact inline line box that clipped its top.
  expect(xml).toContain("<wp:anchor");
  expect(xml).toContain('relativeFrom="paragraph"');
  expect(xml).not.toContain("<wp:inline");
});

it("reconstructs a scanned grid as editable Word cells rather than a background image", async () => {
  const f = fixture();
  f.context.strokeStyle = "black";
  for (const x of [50, 250, 450]) {
    f.page.rules.push({ x1: x, x2: x, y1: 200, y2: 300 });
    f.context.beginPath();
    f.context.moveTo(x, 200);
    f.context.lineTo(x, 300);
    f.context.stroke();
  }
  for (const y of [200, 250, 300]) {
    f.page.rules.push({ x1: 50, x2: 450, y1: y, y2: y });
    f.context.beginPath();
    f.context.moveTo(50, y);
    f.context.lineTo(450, y);
    f.context.stroke();
  }
  f.text("Name", 60, 220);
  f.text("Amount", 260, 220);
  f.text("Alice", 60, 270);
  f.text("1250.00", 260, 270);
  await f.convert();
  const model = analyzeLayout([f.page]);
  expect(model.stats).toMatchObject({ tables: 1, images: 0 });
  const zip = await JSZip.loadAsync(
    await (await exportDocx(model, { preservePageBreaks: true })).arrayBuffer()
  );
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml.match(/<w:tc>/gu)).toHaveLength(4);
  expect(xml).toContain("1250.00");
  expect(xml).not.toContain("<w:drawing>");
});

it("keeps one uncertain paragraph together despite alternating confidence and fragmented OCR IDs", async () => {
  const f = fixture();
  f.text("Clear heading:", 50, 45);
  for (let i = 0; i < 5; i++)
    f.text(
      `Paragraph content row ${i} continues without a break`,
      50,
      80 + i * 18,
      {
        confidence: i === 1 || i === 3 ? 50 : 96,
        paragraphId: `wrong-ocr-paragraph-${i}`,
      }
    );
  f.text("Independent editable paragraph.", 50, 220);
  await f.convert();
  expect(f.page.spans.map((s) => !!s.rasterized)).toEqual([
    false,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  expect(f.page.figures.filter((f) => f.role === "scan-region")).toHaveLength(
    1
  );
  const model = analyzeLayout([f.page]);
  const zip = await JSZip.loadAsync(
    await (await exportDocx(model, { preservePageBreaks: true })).arrayBuffer()
  );
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).toContain("Independent editable paragraph.");
  expect(xml).not.toContain("Paragraph content row");
  expect(xml.match(/<w:drawing>/gu)).toHaveLength(1);
});

it("preserves the whole paragraph when a watermark crosses only its middle row", async () => {
  const f = fixture();
  f.context.fillStyle = "#99aacc";
  f.context.fillRect(130, 120, 90, 34);
  for (let i = 0; i < 3; i++)
    f.text(
      "Reliable OCR over an unreliable watermark region",
      50,
      100 + i * 24
    );
  f.text("Next paragraph is still editable.", 50, 220);
  await f.convert();
  expect(f.page.spans.map((s) => !!s.rasterized)).toEqual([
    true,
    true,
    true,
    false,
  ]);
  expect(f.page.figures.filter((f) => f.role === "scan-region")).toHaveLength(
    1
  );
});

it("respects list boundaries in double-spaced scans without making the entire page an image", async () => {
  const f = fixture();
  const rows = [
    "1. First independent clause continues here",
    "Continuation contains an uncertain value",
    "Final line of the first clause.",
    "2. Reliable second clause continues here",
    "Reliable continuation remains editable",
    "Final line of the second clause.",
  ];
  rows.forEach((text, i) =>
    f.text(text, 50, 80 + i * 32, {
      confidence: i === 1 ? 40 : 96,
      paragraphId: "one-wrong-ocr-block",
    })
  );
  await f.convert();
  expect(f.page.spans.map((s) => !!s.rasterized)).toEqual([
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
  expect(f.page.figures.filter((f) => f.role === "scan-region")).toHaveLength(
    1
  );
});

it("keeps a fully reliable multiline paragraph editable", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++)
    f.text("Readable paragraph continuation", 50, 80 + i * 20);
  await f.convert();
  expect(f.page.spans.every((s) => !s.rasterized)).toBe(true);
  expect(f.page.figures).toEqual([]);
});

it("does not absorb independent form labels or text beyond a separator", async () => {
  const f = fixture();
  f.text("Name:", 50, 50, { confidence: 45 });
  f.text("Address:", 50, 68);
  f.text("Phone:", 50, 86);
  f.text("An uncertain complete paragraph", 50, 140, { confidence: 45 });
  f.page.rules.push({ x1: 50, x2: 450, y1: 157, y2: 157 });
  f.text("A reliable independent paragraph", 50, 163);
  await f.convert();
  expect(f.page.spans.map((s) => !!s.rasterized)).toEqual([
    true,
    false,
    false,
    true,
    false,
  ]);
});

it("preserves an empty scanned grid instead of erasing all but its bottom rule", async () => {
  const f = fixture();
  f.text("Reliable body above the form", 50, 50);
  f.context.strokeStyle = "black";
  for (const x of [50, 250, 450]) {
    f.page.rules.push({ x1: x, x2: x, y1: 200, y2: 300 });
    f.context.beginPath();
    f.context.moveTo(x, 200);
    f.context.lineTo(x, 300);
    f.context.stroke();
  }
  for (const y of [200, 250, 300]) {
    f.page.rules.push({ x1: 50, x2: 450, y1: y, y2: y });
    f.context.beginPath();
    f.context.moveTo(50, y);
    f.context.lineTo(450, y);
    f.context.stroke();
  }
  await f.convert();
  expect(f.page.spans[0].rasterized).not.toBe(true);
  expect(f.page.figures).toHaveLength(1);
  expect(f.page.figures[0]).toMatchObject({ role: "scan-region" });
  expect(f.page.figures[0].height).toBeGreaterThanOrEqual(100);
  expect(f.page.rules).toEqual([]);
});

it("retains underlined numbers as original pixels even when OCR gives them high confidence", async () => {
  const f = fixture();
  f.text("54.319", 60, 80);
  f.text("Reliable body", 60, 120);
  f.context.fillStyle = "black";
  f.context.fillRect(57, 94, f.page.spans[0].width + 6, 1);
  const source = f.context.getImageData(0, 0, 600, 800);
  await f.convert();
  expect(f.page.spans.map((s) => !!s.rasterized)).toEqual([true, false]);
  const region = f.page.figures[0];
  const image = await loadImage(region.data);
  const check = createCanvas(image.width, image.height),
    ctx = check.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    const offset =
      ((Math.floor(region.y) + y) * 600 + Math.floor(region.x)) * 4;
    expect(
      pixels.data.slice(y * image.width * 4, (y + 1) * image.width * 4)
    ).toEqual(source.data.slice(offset, offset + image.width * 4));
  }
});

it("keeps a colored heading as native colored text, not artwork", async () => {
  const f = fixture();
  f.text("Colored heading", 50, 50, { color: "1258AA" });
  const regions = scanColorRegions(
    f.context.getImageData(0, 0, 600, 800),
    1,
    f.page.spans
  );
  expect(regions).toEqual([]);
  await f.convert();
  expect(f.page.spans[0].rasterized).not.toBe(true);
  expect(f.page.spans[0].color).toMatch(/^[0-9a-f]{6}$/u);
  expect(f.page.figures).toEqual([]);
});

it("retains thin colored banners including black lettering completely missed by OCR", async () => {
  const f = fixture();
  f.text("Editable body", 50, 50);
  f.context.fillStyle = "#ffff00";
  f.context.fillRect(40, 150, 520, 14);
  f.context.fillStyle = "#000000";
  f.context.fillText("Unrecognized heading", 170, 161);
  await f.convert();
  const region = f.page.figures.find(
    (figure) => figure.role === "scan-region"
  )!;
  expect(region).toBeDefined();
  expect(region.y).toBeLessThanOrEqual(150);
  expect(region.y + region.height).toBeGreaterThanOrEqual(164);
  expect(f.page.spans[0].rasterized).not.toBe(true);
  const img = await loadImage(region.data);
  const canvas = createCanvas(img.width, img.height),
    ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
  let black = 0,
    yellow = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (
      pixels[i + 3] > 200 &&
      pixels[i] < 90 &&
      pixels[i + 1] < 90 &&
      pixels[i + 2] < 90
    )
      black++;
    if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] < 40) yellow++;
  }
  expect(black).toBeGreaterThan(50);
  expect(yellow).toBeGreaterThan(1000);
});

it("retains a colored stamp independently while body text remains native", async () => {
  const f = fixture();
  f.text("Editable body", 50, 50);
  f.context.strokeStyle = "#cc2233";
  f.context.lineWidth = 3;
  f.context.beginPath();
  f.context.arc(400, 500, 45, 0, Math.PI * 2);
  f.context.stroke();
  f.text("APPROVED", 367, 493, { color: "cc2233" });
  await f.convert();
  expect(f.page.spans[0].rasterized).not.toBe(true);
  expect(f.page.spans[1].rasterized).toBe(true);
  expect(f.page.figures).toHaveLength(1);
  expect(f.page.figures[0]).toMatchObject({ overlay: true, behindText: true });
  expect(f.page.figures[0].width).toBeLessThan(120);
  const cropped = await loadImage(f.page.figures[0].data);
  const check = createCanvas(cropped.width, cropped.height),
    ctx = check.getContext("2d");
  ctx.drawImage(cropped, 0, 0);
  expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(0);
  const model = analyzeLayout([f.page]);
  expect(model.stats.characters).toBe("Editablebody".length);
});

it("preserves only the watermark-overlap band as pixels, even if OCR reports high confidence", async () => {
  const f = fixture();
  f.context.fillStyle = "#99aacc";
  f.context.fillRect(90, 180, 130, 90);
  f.text("Body crossing watermark", 60, 210);
  f.text("Another editable line", 60, 300);
  await f.convert();
  expect(f.page.spans.map((span) => !!span.rasterized)).toEqual([true, false]);
  expect(f.page.figures).toHaveLength(1);
  expect(f.page.figures[0]).toMatchObject({ role: "scan-region" });
  expect(f.page.figures[0].height).toBeLessThan(120);
  expect(
    f.page.figures.some((figure) => figure.role === "scan-background")
  ).toBe(false);
});

it("retains a pale gray watermark extension below its colored part", async () => {
  const f = fixture();
  f.context.fillStyle = "#99aacc";
  f.context.fillRect(90, 180, 130, 90);
  f.context.fillStyle = "#dddddd";
  f.context.fillRect(115, 272, 25, 30);
  f.context.fillRect(170, 272, 25, 30);
  f.text("Watermark overlap", 60, 210);
  f.text("Clear body below", 60, 350);
  await f.convert();
  const region = f.page.figures.find(
    (figure) => figure.role === "scan-region"
  )!;
  expect(region.y + region.height).toBeGreaterThanOrEqual(302);
  expect(f.page.spans.map((span) => !!span.rasterized)).toEqual([true, false]);
});

it("keeps reliable body outside a large watermark editable and does not duplicate its crossing words", async () => {
  const f = fixture();
  f.context.strokeStyle = "#88aacc";
  f.context.lineWidth = 18;
  f.context.beginPath();
  f.context.moveTo(200, 300);
  f.context.lineTo(400, 430);
  f.context.lineTo(220, 510);
  f.context.stroke();
  f.text("123", 290, 370);
  f.text("Body elsewhere", 60, 60);
  // This is deliberately a region the ordinary illustration detector accepts.
  expect(
    scanGraphics(f.context.getImageData(0, 0, 600, 800), 1, f.page.spans, [])
  ).toHaveLength(1);
  await f.convert();
  expect(f.page.spans.map((span) => !!span.rasterized)).toEqual([true, false]);
  expect(f.page.figures).toHaveLength(1);
  expect(f.page.figures[0]).toMatchObject({ role: "scan-region" });
});

it("straightens a tilted form before finding its editable grid and ignores paper-edge strokes", () => {
  const f = fixture();
  f.context.save();
  f.context.translate(300, 400);
  f.context.rotate(Math.PI / 180);
  f.context.translate(-300, -400);
  f.context.strokeStyle = "black";
  f.context.lineWidth = 2;
  for (const y of [200, 240, 280, 320, 360, 400, 440]) {
    f.context.beginPath();
    f.context.moveTo(60, y);
    f.context.lineTo(540, y);
    f.context.stroke();
  }
  for (const x of [60, 220, 380, 540]) {
    f.context.beginPath();
    f.context.moveTo(x, 200);
    f.context.lineTo(x, 440);
    f.context.stroke();
  }
  f.context.restore();
  expect(scanSkew(f.context.getImageData(0, 0, 600, 800))).toBeCloseTo(1, 0);
  deskewScan(f.image as unknown as HTMLCanvasElement);
  f.context.strokeRect(1, 1, 598, 798);
  const rules = scanRules(f.context.getImageData(0, 0, 600, 800), 1);
  expect(rules.filter((rule) => rule.y1 === rule.y2)).toHaveLength(7);
  expect(rules.filter((rule) => rule.x1 === rule.x2)).toHaveLength(4);
  expect(rules.every((rule) => rule.x1 > 10 && rule.y1 > 10)).toBe(true);
});

it("does not rotate already straight text or a blank scan", () => {
  const f = fixture();
  expect(scanSkew(f.context.getImageData(0, 0, 600, 800))).toBe(0);
  for (let y = 80; y < 600; y += 24)
    f.text("An ordinary horizontal body paragraph without scanner tilt", 60, y);
  expect(scanSkew(f.context.getImageData(0, 0, 600, 800))).toBe(0);
});

it("labels the exceptional image-only fallback instead of calling it editable", async () => {
  const f = fixture();
  f.context.fillStyle = "black";
  f.context.fillRect(50, 50, 20, 10);
  await f.convert();
  expect(f.page.figures[0].role).toBe("scan-background");
  expect(
    f.page.issues.some((issue) => issue.message.includes("無法直接編輯"))
  ).toBe(true);
  expect(analyzeLayout([f.page]).stats.characters).toBe(0);
});

it("does not erase dark photographic texture as a table grid", () => {
  const f = fixture();
  f.context.fillStyle = "#606060";
  f.context.fillRect(40, 40, 520, 500);
  f.context.strokeStyle = "#151515";
  f.context.lineWidth = 1;
  for (let n = 60; n < 500; n += 20) {
    f.context.beginPath();
    f.context.moveTo(50, n);
    f.context.lineTo(550, n);
    f.context.moveTo(n, 50);
    f.context.lineTo(n, 530);
    f.context.stroke();
  }
  const rules = scanRules(f.context.getImageData(0, 0, 600, 800), 1);
  // The picture's outer frame may remain; its internal texture must not.
  expect(
    rules.every((r) => r.y1 < 45 || r.y1 > 535 || r.x1 < 45 || r.x1 > 555)
  ).toBe(true);
});

it("retains one complete original when no paragraph has reliable editable text", async () => {
  const f = fixture();
  f.text("Uncertain first line", 50, 50, { confidence: 20 });
  f.text("Uncertain second line", 50, 70, { confidence: 30 });
  f.context.fillStyle = "#3268b0";
  f.context.fillRect(300, 300, 150, 200);
  await f.convert();
  expect(f.page.figures).toHaveLength(1);
  expect(f.page.figures[0]).toMatchObject({
    role: "scan-background",
    overlay: true,
    width: 600,
    height: 800,
  });
  expect(f.page.spans.every((s) => s.rasterized)).toBe(true);
  expect(f.page.rules).toEqual([]);
  const model = analyzeLayout([f.page]);
  expect(model.stats.characters).toBe(0);
  expect(model.stats.images).toBe(1);
});
