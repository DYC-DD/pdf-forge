import { readFileSync } from "node:fs";

import { degrees, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { OPS, type PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PDF_PREVIEW_LIMITS } from "../shared/pdf/limits";
import { openPdf, renderPageThumbnail } from "../shared/pdf/preview";
import { configurePreviewCanvas } from "../shared/pdf/previewCanvas";

// Use PDF.js's Node-compatible build while exercising real CMap loading.
vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL(
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url
  ).pathname,
}));

beforeEach(() => {
  // Vite generates the same public resources for tests, development and builds.
  vi.stubEnv("BASE_URL", new URL("../../public/", import.meta.url).pathname);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PDF preview canvas limits", () => {
  function makeCanvas() {
    return {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
    } as HTMLCanvasElement;
  }

  function expectBoundedCanvas(canvas: HTMLCanvasElement) {
    expect(canvas.width).toBeGreaterThanOrEqual(1);
    expect(canvas.height).toBeGreaterThanOrEqual(1);
    expect(canvas.width).toBeLessThanOrEqual(PDF_PREVIEW_LIMITS.canvasEdge);
    expect(canvas.height).toBeLessThanOrEqual(PDF_PREVIEW_LIMITS.canvasEdge);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(
      PDF_PREVIEW_LIMITS.canvasPixels
    );
  }

  it.each([
    [1, 600, 800],
    [1.5, 900, 1200],
    [2, 1200, 1600],
    [3, 1200, 1600],
  ])(
    "preserves ordinary page resolution at device pixel ratio %s",
    (devicePixelRatio, expectedWidth, expectedHeight) => {
      const canvas = makeCanvas();
      configurePreviewCanvas(
        canvas,
        { width: 600, height: 800 },
        devicePixelRatio
      );
      expect(canvas.width).toBe(expectedWidth);
      expect(canvas.height).toBe(expectedHeight);
      expect(canvas.style).toEqual({ width: "600px", height: "800px" });
    }
  );

  it.each([
    [600, 100_000],
    [100_000, 600],
    [10_000, 10_000],
    [2000.25, 1999.75],
    [0.000001, 1_000_000],
    [1_000_000, 0.000001],
  ])(
    "bounds a %s × %s bitmap while preserving display size and the complete page",
    (width, height) => {
      const canvas = makeCanvas();
      const transform = configurePreviewCanvas(canvas, { width, height }, 2);
      expectBoundedCanvas(canvas);
      expect(canvas.style).toEqual({
        width: `${width}px`,
        height: `${height}px`,
      });
      // Both page edges must map into the bitmap, including fractional rounding.
      expect(width * transform[0]).toBeCloseTo(canvas.width);
      expect(height * transform[3]).toBeCloseTo(canvas.height);
      expect([transform[1], transform[2], transform[4], transform[5]]).toEqual([
        0, 0, 0, 0,
      ]);
    }
  );

  it.each([
    [4096, 900],
    [2000, 2000],
  ])("retains resolution exactly at the %s × %s boundary", (width, height) => {
    const canvas = makeCanvas();
    configurePreviewCanvas(canvas, { width, height });
    expect(canvas.width).toBe(width);
    expect(canvas.height).toBe(height);
    expectBoundedCanvas(canvas);
  });

  it.each([0, -1, NaN, Infinity])(
    "uses a safe density for device pixel ratio %s",
    (devicePixelRatio) => {
      const canvas = makeCanvas();
      configurePreviewCanvas(
        canvas,
        { width: 600, height: 800 },
        devicePixelRatio
      );
      expect(canvas.width).toBe(600);
      expect(canvas.height).toBe(800);
    }
  );

  it.each([
    [0, 800],
    [600, -1],
    [NaN, 800],
    [600, Infinity],
  ])(
    "rejects invalid %s × %s dimensions before allocation",
    (width, height) => {
      const canvas = makeCanvas();
      expect(() => configurePreviewCanvas(canvas, { width, height })).toThrow(
        "PDF 頁面尺寸不正確"
      );
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
    }
  );

  it.each([0, 90])(
    "bounds a long second page rotated %s degrees independently of the first page",
    async (rotation) => {
      const document = await PDFDocument.create();
      document.addPage([600, 800]);
      document.addPage([600, 100_000]).setRotation(degrees(rotation));
      const file = new File(
        [new Uint8Array(await document.save())],
        "mixed.pdf"
      );
      const task = await openPdf(file);
      try {
        const pdf = await task.promise;
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        const scale = 0.9;
        const page = await pdf.getPage(2);
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(scale, (first.width * scale) / original.width),
        });
        const canvas = makeCanvas();
        configurePreviewCanvas(canvas, viewport, 2);
        expectBoundedCanvas(canvas);
        expect(canvas.style).toEqual({
          width: `${viewport.width}px`,
          height: `${viewport.height}px`,
        });
      } finally {
        await task.destroy();
      }
    }
  );
});

it("applies the image decoding limit to compression previews", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const image = await document.embedJpg(
    readFileSync(new URL("./fixtures/source.jpg", import.meta.url))
  );
  page.drawImage(image, { width: 100, height: 100 });
  const file = new File([new Uint8Array(await document.save())], "image.pdf");
  const task = await openPdf(file, 1_000_000);
  try {
    const pdf = await task.promise;
    const operations = await (await pdf.getPage(1)).getOperatorList();
    expect(operations.fnArray).not.toContain(OPS.paintImageXObject);
    expect(operations.fnArray).not.toContain(OPS.paintInlineImageXObject);
  } finally {
    await task.destroy();
  }
});

it.each([
  [1, 360, 480],
  [1.5, 540, 720],
  [2, 720, 960],
  [3, 720, 960],
])(
  "renders sharp grid thumbnails at device pixel ratio %s with a bounded density",
  async (devicePixelRatio, expectedWidth, expectedHeight) => {
    const canvas = { width: 0, height: 0, toDataURL: () => "thumbnail" };
    vi.stubGlobal("window", { devicePixelRatio });
    vi.stubGlobal("document", { createElement: () => canvas });
    let renderedSize: [number, number] | undefined;
    const pdf = {
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => {
          renderedSize = [canvas.width, canvas.height];
          return { promise: Promise.resolve() };
        },
        cleanup: vi.fn(),
      }),
    } as unknown as PDFDocumentProxy;

    expect((await renderPageThumbnail(pdf, 1)).src).toBe("thumbnail");
    expect(renderedSize).toEqual([expectedWidth, expectedHeight]);
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  }
);

it.each([
  [100, 1_000_000],
  [1_000_000, 100],
  [10_000, 10_000],
])(
  "bounds thumbnail dimensions for a %s × %s page and releases the canvas",
  async (width, height) => {
    const canvas = { width: 0, height: 0, toDataURL: () => "thumbnail" };
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    vi.stubGlobal("document", { createElement: () => canvas });
    let renderedSize: [number, number] | undefined;
    const cleanup = vi.fn();
    const pdf = {
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: width * scale,
          height: height * scale,
        }),
        render: () => {
          renderedSize = [canvas.width, canvas.height];
          return { promise: Promise.resolve() };
        },
        cleanup,
      }),
    } as unknown as PDFDocumentProxy;
    expect((await renderPageThumbnail(pdf, 1, 4000)).src).toBe("thumbnail");
    expect(renderedSize![0]).toBeGreaterThanOrEqual(1);
    expect(renderedSize![1]).toBeGreaterThanOrEqual(1);
    expect(renderedSize![0]).toBeLessThanOrEqual(2048);
    expect(renderedSize![1]).toBeLessThanOrEqual(2048);
    expect(canvas).toMatchObject({ width: 0, height: 0 });
    expect(cleanup).toHaveBeenCalledOnce();
  }
);

it.each([
  [600, 800, 0, 3 / 4],
  [800, 600, 0, 4 / 3],
  [600, 800, 90, 4 / 3],
  [800, 600, 270, 3 / 4],
])(
  "preserves the displayed aspect ratio of a %s × %s page rotated %s degrees",
  async (width, height, rotation, expectedRatio) => {
    const document = await PDFDocument.create();
    document.addPage([width, height]).setRotation(degrees(rotation));
    const file = new File(
      [new Uint8Array(await document.save())],
      "orientation.pdf",
      { type: "application/pdf" }
    );
    const task = await openPdf(file);
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const canvas = { width: 0, height: 0, toDataURL: () => "thumbnail" };
      vi.stubGlobal("document", { createElement: () => canvas });
      const render = vi.spyOn(page, "render").mockReturnValue({
        promise: Promise.resolve(),
      } as ReturnType<typeof page.render>);
      try {
        const thumbnail = await renderPageThumbnail(pdf, 1);
        expect(thumbnail.src).toBe("thumbnail");
        expect(thumbnail.aspectRatio).toBeCloseTo(expectedRatio);
      } finally {
        render.mockRestore();
      }
    } finally {
      await task.destroy();
    }
  }
);

describe("Chinese PDF previews", () => {
  it.each([
    ["ETen-B5-H", "MSung-Light", "CNS1", "A4A4A4E5"],
    ["UniGB-UCS2-H", "STSong-Light", "GB1", "4E2D6587"],
  ])(
    "loads Chinese text using the %s CMap",
    async (encoding, font, ordering, text) => {
      const document = await PDFDocument.create();
      const page = document.addPage([300, 300]);
      const context = document.context;
      const cidFont = context.register(
        context.obj({
          Type: "Font",
          Subtype: "CIDFontType0",
          BaseFont: font,
          CIDSystemInfo: {
            Registry: PDFString.of("Adobe"),
            Ordering: PDFString.of(ordering),
            Supplement: 0,
          },
          DW: 1000,
        })
      );
      const compositeFont = context.register(
        context.obj({
          Type: "Font",
          Subtype: "Type0",
          BaseFont: font,
          Encoding: encoding,
          DescendantFonts: [cidFont],
        })
      );
      page.node.set(
        PDFName.of("Resources"),
        context.obj({ Font: { F1: compositeFont } })
      );
      page.node.set(
        PDFName.of("Contents"),
        context.register(
          context.flateStream(`BT /F1 24 Tf 20 100 Td <${text}> Tj ET`)
        )
      );
      const file = new File(
        [new Uint8Array(await document.save())],
        "chinese.pdf",
        {
          type: "application/pdf",
        }
      );

      const task = await openPdf(file);
      try {
        const pdf = await task.promise;
        const content = await (await pdf.getPage(1)).getTextContent();
        const extracted = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join("");
        expect(extracted).toBe("中文");
      } finally {
        await task.destroy();
      }
    }
  );
});
