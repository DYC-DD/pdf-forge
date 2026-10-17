import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import {
  BlendMode,
  clip,
  degrees,
  endPath,
  fill,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setTextRenderingMode,
  StandardFonts,
  TextRenderingMode,
  translate,
} from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzePdf } from "../features/pdf2docx/lib/analyzePdf";
import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import {
  captureFigures,
  extractPage,
  figureRegions,
  renderPage,
} from "../features/pdf2docx/lib/extractPage";
import { DOCX_LIMITS } from "../features/pdf2docx/lib/limits";
import { paragraphText } from "../features/pdf2docx/lib/paragraphs";
import { openPdf } from "../shared/pdf/preview";

vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL(
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url
  ).href,
}));

beforeEach(() => {
  vi.stubEnv(
    "BASE_URL",
    fileURLToPath(new URL("../../public/", import.meta.url)).replaceAll(
      "\\",
      "/"
    )
  );
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("canvas");
      const canvas = createCanvas(1, 1);
      Object.assign(canvas, {
        toBlob: (callback: (blob: Blob) => void, mime = "image/png") =>
          callback(
            new Blob([new Uint8Array(canvas.toBuffer(mime as "image/png"))], {
              type: mime,
            })
          ),
      });
      return canvas;
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("isolates image paint after PDF.js optimizes preceding path operations", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([240, 240]);
  // Each save/translate/path/restore quartet is folded by the render optimizer,
  // but remains four operations in getOperatorList().
  for (let i = 0; i < 12; i++)
    page.pushOperators(
      pushGraphicsState(),
      translate(10 + i * 14, 200),
      rectangle(0, 0, 8, 8),
      fill(),
      popGraphicsState()
    );
  const bitmap = createCanvas(10, 10),
    ctx = bitmap.getContext("2d");
  ctx.fillStyle = "#0066ff";
  ctx.fillRect(0, 0, 10, 10);
  const picture = await pdf.embedPng(bitmap.toBuffer("image/png"));
  page.drawImage(picture, { x: 50, y: 100, width: 30, height: 30 });
  page.drawText("Editable body after the picture", { x: 20, y: 50, size: 12 });
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "optimized.pdf")
  );
  let isolated: HTMLCanvasElement | undefined;
  try {
    const source = await (await task.promise).getPage(1);
    isolated = (await renderPage(source, 1, undefined, { imagesOnly: true }))
      .canvas;
    const pixels = isolated.getContext("2d")!.getImageData(0, 0, 240, 240);
    const at = (x: number, y: number) =>
      Array.from(pixels.data.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 4));
    expect(at(65, 120)).toEqual([0, 102, 255, 255]);
    expect(at(12, 35)[3]).toBe(0);
    for (let y = 175; y < 200; y++)
      for (let x = 15; x < 235; x++) expect(at(x, y)[3]).toBe(0);
    const { raw } = await extractPage(source);
    expect(raw.spans.map((s) => s.text).join("")).toContain(
      "Editable body after the picture"
    );
  } finally {
    if (isolated) isolated.width = isolated.height = 0;
    await task.destroy();
  }
});

it("keeps lettering on a photo in a small table cell while retaining native neighboring cells", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  for (const x of [40, 220, 400])
    page.drawLine({ start: { x, y: 400 }, end: { x, y: 600 }, thickness: 1 });
  for (const y of [400, 500, 600])
    page.drawLine({ start: { x: 40, y }, end: { x: 400, y }, thickness: 1 });
  const bitmap = createCanvas(100, 60);
  const ctx = bitmap.getContext("2d");
  ctx.fillStyle = "#0066aa";
  ctx.fillRect(0, 0, 100, 60);
  const picture = await pdf.embedPng(bitmap.toBuffer("image/png"));
  page.drawImage(picture, { x: 240, y: 520, width: 100, height: 60 });
  page.drawText("PHOTO", { x: 250, y: 540, size: 14, color: rgb(1, 1, 1) });
  page.drawText("Editable neighboring cell", { x: 50, y: 550, size: 12 });
  page.drawText("Editable lower row", { x: 50, y: 450, size: 12 });
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "table-photo.pdf")
  );
  try {
    const source = await (await task.promise).getPage(1);
    const { raw, imageBoxes } = await extractPage(source);
    expect(raw.spans.find((s) => s.text === "PHOTO")?.rasterized).toBe(true);
    expect(
      raw.spans.find((s) => s.text === "Editable neighboring cell")?.rasterized
    ).not.toBe(true);
    const crop = imageBoxes.find((box) => box.fullContent && box.x === 220);
    expect(crop).toMatchObject({ width: 180, height: 100, overlay: true });
    await captureFigures(source, raw, imageBoxes);
    const figure = raw.figures.find((f) => f.x === 220)!;
    const decoded = await loadImage(figure.data);
    const canvas = createCanvas(decoded.width, decoded.height);
    const context = canvas.getContext("2d");
    context.drawImage(decoded, 0, 0);
    const scale = canvas.width / figure.width;
    // Inspect only the blue photo, excluding its white cell background.
    const pixels = context.getImageData(
      21 * scale,
      21 * scale,
      98 * scale,
      58 * scale
    ).data;
    let white = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] > 230 && pixels[i + 1] > 230 && pixels[i + 2] > 230)
        white++;
    expect(white).toBeGreaterThan(30);
  } finally {
    await task.destroy();
  }
});

async function makeDocument() {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);
  page.drawText("Editable document", { x: 50, y: 780, size: 20, font: bold });
  page.drawText("This is a wrapped paragraph with complete source text", {
    x: 50,
    y: 740,
    size: 12,
    font: normal,
  });
  page.drawText("that continues as one editable paragraph.", {
    x: 50,
    y: 724,
    size: 12,
    font: normal,
  });
  page.drawText("1. First item", { x: 50, y: 680, size: 12, font: normal });
  page.drawText("2. Second item", { x: 50, y: 660, size: 12, font: normal });
  for (const [x1, y1, x2, y2] of [
    [50, 590, 530, 590],
    [50, 540, 370, 540],
    [50, 490, 530, 490],
    [50, 440, 530, 440],
    [50, 440, 50, 590],
    [210, 440, 210, 540],
    [370, 440, 370, 590],
    [530, 440, 530, 590],
  ])
    page.drawLine({
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
      thickness: 0.5,
    });
  for (const [text, x, y] of [
    ["Merged header", 60, 565],
    ["Tall cell", 380, 565],
    ["A", 60, 515],
    ["B", 220, 515],
    ["C", 60, 465],
    ["D", 220, 465],
    ["E", 380, 465],
  ] as const)
    page.drawText(text, { x, y, size: 12, font: normal });
  const canvas = createCanvas(80, 50),
    context = canvas.getContext("2d");
  context.fillStyle = "#3268b0";
  context.fillRect(0, 0, 80, 50);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(image, { x: 50, y: 330, width: 80, height: 50 });
  const second = pdf.addPage([595, 842]);
  second.drawText("Second page", { x: 50, y: 780, size: 20, font: bold });
  second.drawText("Source pages remain in their original reading order.", {
    x: 50,
    y: 740,
    size: 12,
    font: normal,
  });
  return new File([new Uint8Array(await pdf.save())], "editable.pdf", {
    type: "application/pdf",
  });
}

describe("PDF2docx with real PDF.js input", () => {
  it("distinguishes clipping rectangles from colored backgrounds", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([595, 842]);
    page.pushOperators(
      pushGraphicsState(),
      rectangle(0, 0, 595, 842),
      clip(),
      endPath()
    );
    page.drawRectangle({
      x: 50,
      y: 600,
      width: 200,
      height: 30,
      color: rgb(0.2, 0.4, 0.8),
      borderWidth: 0,
    });
    page.drawText("Red amount", {
      x: 55,
      y: 610,
      size: 12,
      color: rgb(1, 0, 0),
    });
    page.pushOperators(popGraphicsState());
    const task = await openPdf(
      new File([new Uint8Array(await pdf.save())], "background.pdf")
    );
    try {
      const { raw } = await extractPage(await (await task.promise).getPage(1));
      expect(raw.fills).toHaveLength(1);
      expect(raw.fills![0]).toMatchObject({
        x: 50,
        y: 212,
        width: 200,
        height: 30,
        color: "3366CC",
      });
      expect(raw.spans[0].color).toBe("FF0000");
    } finally {
      await task.destroy();
    }
  });
  it("retains a diagonal watermark as isolated artwork without changing body text", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([595, 842]);
    const body =
      "Editable body paragraph with enough ordinary content to identify its normal font size.";
    page.drawText(body, { x: 50, y: 760, size: 12 });
    page.drawText("WATERMARK", {
      x: 100,
      y: 300,
      size: 50,
      rotate: degrees(45),
      color: rgb(1, 0, 0),
    });
    const model = await analyzePdf(
      new File([new Uint8Array(await pdf.save())], "watermark.pdf"),
      [1],
      { ocr: "off", language: "eng" }
    );
    expect(model.issues.some((issue) => issue.code === "coverage")).toBe(false);
    expect(model.pages[0].overlays).toHaveLength(1);
    expect(model.pages[0].overlays![0].behindText).toBe(true);
    const result = await exportDocx(model, { preservePageBreaks: true });
    const zip = await JSZip.loadAsync(await result.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain(body);
    expect(xml).not.toContain(">WATERMARK<");
    expect(xml).toContain('behindDoc="1"');
    const picture = await loadImage(model.pages[0].overlays![0].data);
    const canvas = createCanvas(picture.width, picture.height),
      context = canvas.getContext("2d");
    context.drawImage(picture, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0,
      black = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 3] > 128) {
        if (pixels[i] > 150 && pixels[i + 1] < 100) red++;
        if (pixels[i] < 50 && pixels[i + 1] < 50 && pixels[i + 2] < 50) black++;
      }
    expect(red).toBeGreaterThan(100);
    expect(black).toBe(0);
  });
  it.each([undefined, BlendMode.Multiply])(
    "keeps a red stamp transparent over editable text (%s)",
    async (blendMode) => {
      const pdf = await PDFDocument.create(),
        page = pdf.addPage([595, 842]);
      for (const [i, value] of [
        "First line",
        "Second line",
        "Third line",
      ].entries())
        page.drawText(value, { x: 60, y: 730 - i * 20, size: 12 });
      const canvas = createCanvas(200, 100),
        context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 200, 100);
      context.strokeStyle = "#ee4444";
      context.lineWidth = 8;
      context.strokeRect(10, 10, 180, 80);
      const image = await pdf.embedPng(canvas.toBuffer("image/png"));
      page.drawImage(image, {
        x: 50,
        y: 650,
        width: 200,
        height: 100,
        blendMode,
      });
      const model = await analyzePdf(
        new File([new Uint8Array(await pdf.save())], "stamp.pdf"),
        [1],
        { ocr: "off", language: "eng" }
      );
      expect(model.pages[0].overlays).toHaveLength(1);
      const picture = await loadImage(model.pages[0].overlays![0].data);
      const crop = createCanvas(picture.width, picture.height),
        ctx = crop.getContext("2d");
      ctx.drawImage(picture, 0, 0);
      expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(0);
      expect(ctx.getImageData(30, 30, 1, 1).data[0]).toBeGreaterThan(100);
      expect(model.stats.characters).toBe(
        "FirstlineSecondlineThirdline".length
      );
    }
  );
  it("preserves an independent map page as an image in automatic mode", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([842, 595]);
    const canvas = createCanvas(500, 300),
      context = canvas.getContext("2d");
    context.fillStyle = "#ccddaa";
    context.fillRect(0, 0, 500, 300);
    const image = await pdf.embedPng(canvas.toBuffer("image/png"));
    page.drawImage(image, { x: 100, y: 120, width: 500, height: 300 });
    const model = await analyzePdf(
      new File([new Uint8Array(await pdf.save())], "map.pdf"),
      [1],
      { ocr: "auto", language: "eng" }
    );
    expect(model.stats).toMatchObject({
      images: 1,
      ocrPages: 0,
      characters: 0,
    });
    expect(model.pages[0].classification?.source).toBe("image");
    const blob = await exportDocx(model, { preservePageBreaks: true });
    expect(blob.size).toBeGreaterThan(1000);
  });
  it("clips pictures to the page and unifies overlapping masks and aligned tiles", () => {
    expect(
      figureRegions(
        [
          { x: -10, y: 20, width: 60, height: 40 },
          { x: 40, y: 20, width: 60, height: 40 },
          { x: 100, y: 20, width: 40, height: 40 },
          { x: 180, y: 80, width: 50, height: 30 },
          { x: 0, y: 0, width: 300, height: 400 },
        ],
        300,
        400
      )
    ).toEqual([
      { x: 0, y: 20, width: 140, height: 40 },
      { x: 180, y: 80, width: 50, height: 30 },
    ]);
  });
  it("retains one visible illustration when PDF image operations overlap", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([595, 842]);
    page.drawText("Pictures remain editable objects", {
      x: 50,
      y: 780,
      size: 16,
    });
    const canvas = createCanvas(160, 100),
      context = canvas.getContext("2d");
    context.fillStyle = "#3268b0";
    context.fillRect(0, 0, 160, 100);
    const image = await pdf.embedPng(canvas.toBuffer("image/png"));
    page.drawImage(image, { x: 50, y: 600, width: 80, height: 50 });
    page.drawImage(image, { x: 110, y: 600, width: 80, height: 50 });
    const model = await analyzePdf(
      new File([new Uint8Array(await pdf.save())], "overlapping.pdf"),
      [1],
      { ocr: "off", language: "eng" }
    );
    expect(model.stats.images).toBe(1);
    const figure = model.pages[0].groups
      .flatMap((group) => group.columns.flat())
      .find((block) => block.kind === "image")!;
    expect(figure).toMatchObject({ x: 50, y: 192, width: 140, height: 50 });
    expect(model.issues.some((issue) => issue.code === "image-overlap")).toBe(
      false
    );
  });
  it("extracts embedded font styles and PDF.js 6 table paths", async () => {
    const task = await openPdf(await makeDocument());
    try {
      const { raw, imageBoxes } = await extractPage(
        await (await task.promise).getPage(1)
      );
      expect(
        raw.spans.find((span) => span.text === "Editable document")
      ).toMatchObject({ bold: true, size: 20 });
      expect(raw.rules).toHaveLength(8);
      expect(imageBoxes[0]).toEqual({ x: 50, y: 462, width: 80, height: 50 });
      expect(raw.issues).not.toContainEqual(
        expect.objectContaining({ code: "path-format" })
      );
    } finally {
      await task.destroy();
    }
  });
  it("preserves text, editable paragraphs, merged table cells and an embedded image", async () => {
    const file = await makeDocument();
    const progress = vi.fn();
    const model = await analyzePdf(file, [2, 1, 1], {
      ocr: "off",
      language: "eng",
      onProgress: progress,
    });
    expect(model.pages.map((page) => page.number)).toEqual([1, 2]);
    expect(model.stats).toMatchObject({ tables: 1, images: 1, ocrPages: 0 });
    expect(model.issues.filter((issue) => issue.severity === "error")).toEqual(
      []
    );
    const paragraphs = model.pages
      .flatMap((page) => page.groups.flatMap((group) => group.columns.flat()))
      .filter((block) => block.kind === "paragraph");
    expect(paragraphs.map(paragraphText)).toContain(
      "This is a wrapped paragraph with complete source text that continues as one editable paragraph."
    );
    expect(progress).toHaveBeenLastCalledWith({
      stage: "layout",
      page: 2,
      total: 2,
    });
    const result = await exportDocx(model, { preservePageBreaks: true });
    const zip = await JSZip.loadAsync(await result.arrayBuffer());
    const document = await zip.file("word/document.xml")!.async("string");
    expect(document).toContain("<w:tbl>");
    expect(document).toContain('<w:gridSpan w:val="2"/>');
    expect(document).toContain("<w:drawing>");
    expect(document).not.toContain("txbxContent");
    expect(document).not.toContain('<w:br w:type="textWrapping"');
    const extracted = document.replace(/<[^>]+>/g, "").replace(/\s/gu, "");
    expect(extracted).toContain(
      "Thisisawrappedparagraphwithcompletesourcetextthatcontinuesasoneeditableparagraph."
    );
    expect(
      Object.keys(zip.files).filter(
        (name) => name.startsWith("word/media/") && !zip.files[name].dir
      )
    ).toHaveLength(1);
    if (process.env.PDF2DOCX_QA_DIR) {
      const directory = resolve(process.env.PDF2DOCX_QA_DIR);
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, "editable.pdf"),
        new Uint8Array(await file.arrayBuffer())
      );
      await writeFile(
        resolve(directory, "editable.docx"),
        new Uint8Array(await result.arrayBuffer())
      );
    }
  });
  it.each(["eng", "chi_tra"])(
    "blocks a %s scanned page when OCR is disabled",
    async (language) => {
      const pdf = await PDFDocument.create(),
        page = pdf.addPage([300, 400]);
      const canvas = createCanvas(600, 800),
        context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 600, 800);
      context.fillStyle = "black";
      context.font = "32px Arial";
      context.fillText("Local OCR 12345", 50, 100);
      if (language === "chi_tra") {
        context.font = '32px "PingFang TC"';
        context.fillText("完全不上傳，純瀏覽器完成。", 50, 160);
        context.fillText("這是可編輯的繁體中文文件。", 50, 210);
      }
      const image = await pdf.embedPng(canvas.toBuffer("image/png"));
      page.drawImage(image, { x: 0, y: 0, width: 300, height: 400 });
      const file = new File([new Uint8Array(await pdf.save())], "scan.pdf");
      const model = await analyzePdf(file, [1], {
        ocr: "off",
        language: "eng",
      });
      expect(model.issues).toContainEqual(
        expect.objectContaining({ code: "scan", severity: "error" })
      );
      await expect(
        exportDocx(model, { preservePageBreaks: false })
      ).rejects.toThrow();
      if (process.env.PDF2DOCX_QA_DIR)
        await writeFile(
          resolve(
            process.env.PDF2DOCX_QA_DIR,
            language === "eng" ? "scan.pdf" : "scan-tra.pdf"
          ),
          new Uint8Array(await file.arrayBuffer())
        );
    }
  );
  it("uses the rotated viewport for page dimensions", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([595, 842]);
    page.drawText("Rotated text", { x: 50, y: 700, size: 12 });
    page.setRotation(degrees(90));
    const model = await analyzePdf(
      new File([new Uint8Array(await pdf.save())], "rotated.pdf"),
      [1],
      { ocr: "off", language: "eng" }
    );
    expect(model.pages[0]).toMatchObject({ width: 842, height: 595 });
    expect(model.issues).toContainEqual(
      expect.objectContaining({ code: "text-direction", severity: "review" })
    );
  });
  it.each([false, true])(
    "only requires OCR for a checkbox when checked=%s",
    async (checked) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([300, 300]);
      page.drawText("Editable form label", { x: 40, y: 250, size: 12 });
      const box = pdf.getForm().createCheckBox("choice");
      box.addToPage(page, { x: 40, y: 200, width: 12, height: 12 });
      if (checked) box.check();
      const model = await analyzePdf(
        new File([new Uint8Array(await pdf.save())], "checkbox.pdf"),
        undefined,
        { ocr: "off" }
      );
      expect(model.issues.some((issue) => issue.code === "annotations")).toBe(
        checked
      );
      expect(model.stats.ocrPages).toBe(0);
      expect(model.stats.characters).toBeGreaterThan(10);
      if (!checked) {
        expect(model.stats.images).toBeGreaterThanOrEqual(1);
        expect(model.pages[0].overlays).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ overlay: true, width: 12, height: 12 }),
          ])
        );
      }
    }
  );

  it("detects visible form values missing from the PDF text layer", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage();
    page.drawText("Form document", { x: 50, y: 700, size: 12 });
    const field = pdf.getForm().createTextField("sample");
    field.setText("Visible form value");
    field.addToPage(page, { x: 50, y: 600, width: 200, height: 30 });
    const model = await analyzePdf(
      new File([new Uint8Array(await pdf.save())], "form.pdf"),
      [1],
      { ocr: "off", language: "eng" }
    );
    expect(model.issues).toContainEqual(
      expect.objectContaining({ code: "annotations", severity: "error" })
    );
    await expect(
      exportDocx(model, { preservePageBreaks: false })
    ).rejects.toThrow("完整讀取");
  });
  it.each([false, true])(
    "preserves only isolated text-field appearances beside native prose (overlap=%s)",
    async (overlap) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([600, 800]);
      for (let row = 0; row < 4; row++)
        page.drawText(
          `Native editable paragraph ${row} with enough visible text to retain.`,
          { x: 50, y: 700 - row * 20, size: 12 }
        );
      const field = pdf.getForm().createTextField("small-note");
      field.setText("Field value");
      field.addToPage(page, {
        x: 50,
        y: overlap ? 690 : 550,
        width: 120,
        height: 24,
      });
      const model = await analyzePdf(
        new File([new Uint8Array(await pdf.save())], "native-field.pdf"),
        [1],
        { ocr: "off" }
      );
      expect(model.issues.some((issue) => issue.code === "annotations")).toBe(
        overlap
      );
      expect(model.stats.characters).toBeGreaterThan(200);
      if (!overlap) {
        expect(model.issues).toContainEqual(
          expect.objectContaining({
            code: "annotation-region",
            severity: "review",
          })
        );
        expect(model.pages[0].overlays).toContainEqual(
          expect.objectContaining({ overlay: true, width: 121, height: 25 })
        );
        const blob = await exportDocx(model, { preservePageBreaks: true });
        const zip = await JSZip.loadAsync(await blob.arrayBuffer());
        expect(await zip.file("word/document.xml")!.async("string")).toContain(
          "Native editable paragraph 3"
        );
        expect(
          Object.keys(zip.files).some(
            (name) => name.startsWith("word/media/") && !zip.files[name].dir
          )
        ).toBe(true);
      }
    }
  );
  it("rejects oversize input, invalid ranges and already cancelled work", async () => {
    const file = new File(["input"], "large.pdf");
    Object.defineProperty(file, "size", { value: DOCX_LIMITS.fileBytes + 1 });
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(
      analyzePdf(file, [1], { ocr: "off", language: "eng" })
    ).rejects.toThrow("32 MB");
    expect(read).not.toHaveBeenCalled();
    await expect(
      analyzePdf(await makeDocument(), [], { ocr: "off", language: "eng" })
    ).rejects.toThrow("沒有可分析");
    await expect(
      analyzePdf(await makeDocument(), [3], { ocr: "off", language: "eng" })
    ).rejects.toThrow("超出");
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzePdf(file, [1], {
        ocr: "off",
        language: "eng",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("scans every page of a document beyond the old fifty-page selection limit", async () => {
    const pdf = await PDFDocument.create();
    for (let number = 1; number <= 51; number++)
      pdf
        .addPage()
        .drawText(`Document content ${number}`, { x: 50, y: 700, size: 12 });
    const model = await analyzePdf(
      new File([new Uint8Array(await pdf.save())], "whole.pdf")
    );
    expect(model.pages.map((page) => page.number)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 1)
    );
    expect(model.stats).toMatchObject({ pages: 51, ocrPages: 0 });
    expect(model.issues.filter((issue) => issue.severity === "error")).toEqual(
      []
    );
    const blob = await exportDocx(model, { preservePageBreaks: true });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Document content 51");
    expect(xml.match(/<w:sectPr>/gu)).toHaveLength(51);
  });
  it("can cancel between pages before layout starts", async () => {
    const controller = new AbortController();
    await expect(
      analyzePdf(await makeDocument(), [1, 2], {
        ocr: "off",
        language: "eng",
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.stage === "read" && progress.page === 2)
            controller.abort();
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("native artwork and paint order regressions", () => {
  it("distinguishes invisible search text from visible text after graphics-state restore", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.pushOperators(
      pushGraphicsState(),
      setTextRenderingMode(TextRenderingMode.Invisible)
    );
    page.drawText("Searchable scan text", { x: 50, y: 700, size: 12, font });
    page.pushOperators(popGraphicsState());
    page.drawText("Visible body text", { x: 50, y: 650, size: 12, font });
    const task = await openPdf(
      new File([new Uint8Array(await pdf.save())], "searchable.pdf")
    );
    try {
      const { raw } = await extractPage(await (await task.promise).getPage(1));
      expect(
        raw.spans.find((s) => s.text === "Searchable scan text")
      ).toMatchObject({ invisible: true, hidden: true });
      expect(
        raw.spans.find((s) => s.text === "Visible body text")?.hidden
      ).toBeFalsy();
    } finally {
      await task.destroy();
    }
  });
  it("recognizes thick filled grid strokes as center lines and keeps cells editable", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const y of [500, 550, 600])
      page.drawRectangle({
        x: 50,
        y: y - 0.96,
        width: 400,
        height: 1.92,
        color: rgb(0, 0, 0),
      });
    for (const x of [50, 250, 450])
      page.drawRectangle({
        x: x - 0.96,
        y: 500,
        width: 1.92,
        height: 100,
        color: rgb(0, 0, 0),
      });
    for (const [text, x, y] of [
      ["A", 60, 570],
      ["B", 260, 570],
      ["C", 60, 520],
      ["D", 260, 520],
    ] as const)
      page.drawText(text, { x, y, size: 12, font });
    const doc = await openPdf(
      new File([new Uint8Array(await pdf.save())], "anonymous.pdf")
    );
    try {
      const { raw } = await extractPage(await (await doc.promise).getPage(1));
      expect(raw.rules).toHaveLength(6);
      const model = (
        await import("../features/pdf2docx/lib/layout")
      ).analyzeLayout([raw]);
      expect(model.stats.tables).toBe(1);
      expect(model.issues.some((issue) => issue.code === "coverage")).toBe(
        false
      );
    } finally {
      await doc.destroy();
    }
  });
  it("omits a hidden template heading covered by a later opaque rectangle", async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Old template", { x: 60, y: 740, size: 12, font });
    page.drawRectangle({
      x: 50,
      y: 730,
      width: 300,
      height: 40,
      color: rgb(0, 0.2, 0.7),
    });
    page.drawText("Visible title", {
      x: 60,
      y: 740,
      size: 12,
      font,
      color: rgb(1, 1, 1),
    });
    page.drawText("Transparent cover", { x: 60, y: 640, size: 12, font });
    page.drawRectangle({
      x: 50,
      y: 630,
      width: 300,
      height: 40,
      color: rgb(1, 1, 1),
      opacity: 0.5,
    });
    const doc = await openPdf(
      new File([new Uint8Array(await pdf.save())], "anonymous.pdf")
    );
    try {
      const { raw } = await extractPage(await (await doc.promise).getPage(1));
      expect(
        raw.spans.find((span) => span.text === "Old template")?.hidden
      ).toBe(true);
      expect(
        raw.spans.find((span) => span.text === "Visible title")?.hidden
      ).toBeFalsy();
      expect(
        raw.spans.find((span) => span.text === "Transparent cover")?.hidden
      ).toBeFalsy();
    } finally {
      await doc.destroy();
    }
  });
});

it("renders isolated vector decorations with a transparent background", async () => {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([595, 842]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 595,
    height: 842,
    color: rgb(1, 1, 1),
  });
  page.drawRectangle({
    x: 50,
    y: 700,
    width: 400,
    height: 30,
    color: rgb(0.2, 0.5, 0.8),
  });
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "art.pdf")
  );
  try {
    const source = await (await task.promise).getPage(1),
      { raw, imageBoxes } = await extractPage(source);
    await (
      await import("../features/pdf2docx/lib/extractPage")
    ).captureFigures(source, raw, imageBoxes);
    expect(raw.figures).toHaveLength(1);
    const im = await loadImage(raw.figures[0].data);
    const canvas = createCanvas(im.width, im.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(im, 0, 0);
    expect(ctx.getImageData(10, 10, 1, 1).data[2]).toBeGreaterThan(100);
  } finally {
    await task.destroy();
  }
});

it("keeps large photographs and vector bars together without rasterizing native body text", async () => {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica),
    c = createCanvas(20, 20),
    ctx = c.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 20, 20);
  const image = await pdf.embedPng(c.toBuffer("image/png"));
  page.drawImage(image, { x: 0, y: 0, width: 595, height: 800 });
  page.drawRectangle({
    x: 0,
    y: 760,
    width: 595,
    height: 40,
    color: rgb(0, 0, 1),
  });
  page.drawText("Editable title", {
    x: 40,
    y: 770,
    font,
    size: 18,
    color: rgb(1, 1, 1),
  });
  page.drawText("1", { x: 550, y: 20, font, size: 12 });
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "illustrated.pdf")
  );
  try {
    const source = await (await task.promise).getPage(1),
      { raw, imageBoxes } = await extractPage(source);
    await (
      await import("../features/pdf2docx/lib/extractPage")
    ).captureFigures(source, raw, imageBoxes);
    expect(raw.figures).toHaveLength(2);
    expect(raw.figures[1].inFooter).toBe(true);
    expect(raw.figures[0].format).toBe("jpg");
    expect([...raw.figures[0].data.slice(0, 2)]).toEqual([255, 216]);
    const im = await loadImage(raw.figures[0].data),
      pixels = createCanvas(im.width, im.height),
      pc = pixels.getContext("2d");
    pc.drawImage(im, 0, 0);
    expect(pc.getImageData(10, 10, 1, 1).data[2]).toBeGreaterThan(200);
    expect(pc.getImageData(10, im.height - 20, 1, 1).data[0]).toBeGreaterThan(
      200
    );
    const model = (
      await import("../features/pdf2docx/lib/layout")
    ).analyzeLayout([raw]);
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: true })
      ).arrayBuffer()
    );
    const document = await zip.file("word/document.xml")!.async("string");
    expect(document).toContain("Editable title");
    expect(document).not.toContain("txbxContent");
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("<wp:anchor");
    expect(footer).toContain("PAGE");
  } finally {
    await task.destroy();
  }
});

it("flags unassigned Unicode from a broken text mapping for automatic OCR", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText("Mapped text");
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "mapping.pdf")
  );
  try {
    const page = await (await task.promise).getPage(1);
    const content = await page.getTextContent();
    const item = content.items.find((item) => "str" in item);
    if (!item || !("str" in item)) throw new Error("Missing fixture text");
    item.str = "文字\u0d49內容";
    vi.spyOn(page, "getTextContent").mockResolvedValue(content);
    const { raw } = await extractPage(page);
    expect(raw.issues.some((issue) => issue.code === "encoding")).toBe(true);
  } finally {
    await task.destroy();
  }
});

it("does not duplicate a photograph already covered by an OCR region", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const canvas = createCanvas(40, 40);
  canvas.getContext("2d").fillRect(0, 0, 40, 40);
  page.drawImage(await pdf.embedPng(canvas.toBuffer("image/png")), {
    x: 100,
    y: 100,
    width: 40,
    height: 40,
  });
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "retained.pdf")
  );
  try {
    const source = await (await task.promise).getPage(1);
    const { raw, imageBoxes } = await extractPage(source);
    raw.source = "ocr";
    raw.figures.push({
      id: "retained",
      x: 90,
      y: 250,
      width: 60,
      height: 60,
      role: "scan-region",
      data: new Uint8Array(canvas.toBuffer("image/png")),
    });
    await captureFigures(source, raw, imageBoxes);
    expect(raw.figures.map((f) => f.id)).toEqual(["retained"]);
  } finally {
    await task.destroy();
  }
});

it("does not discard a retained OCR region when merging its edge image exceeds the background cutoff", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const bitmap = createCanvas(40, 40);
  bitmap.getContext("2d").fillRect(0, 0, 40, 40);
  page.drawImage(await pdf.embedPng(bitmap.toBuffer("image/png")), {
    x: 20,
    y: 100,
    width: 40,
    height: 40,
  });
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "edge-image.pdf")
  );
  try {
    const source = await (await task.promise).getPage(1);
    const { raw, imageBoxes } = await extractPage(source);
    raw.source = "ocr";
    raw.figures.push({
      id: "large-crop",
      x: 40,
      y: 0,
      width: 260,
      height: 400,
      role: "scan-region",
      data: new Uint8Array(bitmap.toBuffer("image/png")),
    });
    await captureFigures(source, raw, imageBoxes);
    expect(raw.figures).toHaveLength(1);
    expect(raw.figures[0]).toMatchObject({
      x: 20,
      y: 0,
      width: 280,
      height: 400,
      role: "scan-region",
    });
  } finally {
    await task.destroy();
  }
});

it("retains local bitmap lettering once and merges a partially overlapping OCR crop", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const canvas = createCanvas(100, 40);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0066ff";
  context.fillRect(0, 0, 100, 40);
  const bitmap = await pdf.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(bitmap, { x: 30, y: 300, width: 100, height: 40 });
  page.drawText("Logo lettering", { x: 35, y: 315, size: 10 });
  page.drawImage(bitmap, { x: 30, y: 180, width: 100, height: 40 });
  page.drawText("Callout lettering", { x: 35, y: 195, size: 10 });
  page.drawText("Editable body", { x: 30, y: 120, size: 12 });
  const task = await openPdf(
    new File([new Uint8Array(await pdf.save())], "local-lettering.pdf")
  );
  try {
    const source = await (await task.promise).getPage(1);
    const { raw, imageBoxes } = await extractPage(source);
    raw.source = "ocr";
    raw.figures.push({
      id: "partial-callout",
      x: 90,
      y: 175,
      width: 80,
      height: 30,
      role: "scan-region",
      data: new Uint8Array(canvas.toBuffer("image/png")),
    });
    await captureFigures(source, raw, imageBoxes);
    expect(raw.spans.filter((s) => !s.rasterized).map((s) => s.text)).toEqual([
      "Editable body",
    ]);
    expect(raw.figures).toHaveLength(2);
    expect(
      raw.figures.every((f) => f.role === "scan-region" && !f.overlay)
    ).toBe(true);
    const callout = raw.figures.find((f) => f.y > 150)!;
    expect(callout.x).toBeLessThanOrEqual(30);
    expect(callout.x + callout.width).toBeGreaterThanOrEqual(170);
    expect(callout.y + callout.height).toBeGreaterThanOrEqual(220);
    const crop = await loadImage(callout.data!);
    const rendered = createCanvas(crop.width, crop.height);
    rendered.getContext("2d").drawImage(crop, 0, 0);
    // The portion outside the original OCR crop must survive the union.
    const pixel = rendered
      .getContext("2d")
      .getImageData(15, crop.height - 9, 1, 1).data;
    expect(Array.from(pixel)).toEqual([0, 102, 255, 255]);
  } finally {
    await task.destroy();
  }
});

it("keeps chart axes and numeric labels together while body text and cell grids remain editable", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  page.drawText("Editable chart introduction", { x: 50, y: 730, size: 14 });
  const mask = createCanvas(20, 20);
  mask.getContext("2d").fillRect(0, 0, 20, 20);
  // A shadow bitmap protrudes 8 pt below the frame, while 92% remains inside.
  page.drawImage(await pdf.embedPng(mask.toBuffer("image/png")), {
    x: 110,
    y: 392,
    width: 100,
    height: 100,
  });
  page.drawRectangle({
    x: 50,
    y: 400,
    width: 400,
    height: 210,
    borderColor: rgb(0.5, 0.5, 0.5),
    borderWidth: 0.8,
  });
  for (const [i, text] of ["120", "240", "360"].entries()) {
    page.drawText(text, { x: 60, y: 440 + i * 50, size: 12 });
    page.drawRectangle({
      x: 110,
      y: 435 + i * 50,
      width: 100 + i * 70,
      height: 25,
      color: rgb(0.1, 0.4, 0.8),
    });
  }
  page.drawText("Editable chart conclusion", { x: 50, y: 360, size: 14 });
  for (const x of [50, 200, 350])
    page.drawLine({ start: { x, y: 100 }, end: { x, y: 250 }, thickness: 0.8 });
  for (const y of [100, 175, 250])
    page.drawLine({ start: { x: 50, y }, end: { x: 350, y }, thickness: 0.8 });
  for (const [text, x, y] of [
    ["123", 60, 215],
    ["456", 210, 215],
    ["789", 60, 140],
    ["012", 210, 140],
  ] as const)
    page.drawText(text, { x, y, size: 12 });
  const model = await analyzePdf(
    new File([new Uint8Array(await pdf.save())], "chart.pdf")
  );
  expect(model.stats.tables).toBe(1);
  const charts = model.pages[0].groups
    .flatMap((g) => g.columns.flat())
    .filter((b) => b.kind === "image" && b.role === "graphic-region");
  expect(charts).toHaveLength(1);
  expect(charts[0].height).toBeGreaterThanOrEqual(218);
  expect(model.pages[0].overlays ?? []).toHaveLength(0);
  const zip = await JSZip.loadAsync(
    await (await exportDocx(model, { preservePageBreaks: true })).arrayBuffer()
  );
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).toContain("Editable chart introduction");
  expect(xml).toContain("Editable chart conclusion");
  expect(xml).toContain(">123</w:t>");
  expect(xml).not.toContain(">120</w:t>");
  expect(xml).not.toContain(">240</w:t>");
  expect(xml).not.toContain(">360</w:t>");
});
