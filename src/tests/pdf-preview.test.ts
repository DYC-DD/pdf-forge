import { readFileSync } from "node:fs";

import { degrees, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { OPS, type PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openPdf, renderPageThumbnail } from "../shared/pdf/preview";

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
