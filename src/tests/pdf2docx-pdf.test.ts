import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import {
  BlendMode,
  clip,
  degrees,
  endPath,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzePdf } from "../features/pdf2docx/lib/analyzePdf";
import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import {
  extractPage,
  figureRegions,
} from "../features/pdf2docx/lib/extractPage";
import { DOCX_LIMITS } from "../features/pdf2docx/lib/limits";
import { paragraphText } from "../features/pdf2docx/lib/paragraphs";
import { openPdf } from "../shared/pdf/preview";

vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL(
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url
  ).pathname,
}));

beforeEach(() => {
  vi.stubEnv("BASE_URL", new URL("../../public/", import.meta.url).pathname);
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
    ).rejects.toThrow("1～50");
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
