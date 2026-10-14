import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { degrees, PDFDocument, rgb } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  convertPdfToImages,
  IMAGE_CONVERSION_LIMITS,
  imageOutputStem,
  type ImageFormat,
} from "../features/convert/lib/convertPdfToImages";

vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL(
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url
  ).href,
}));

const canvases: Canvas[] = [];
const options = {
  pages: [1],
  format: "jpg" as ImageFormat,
  outputName: "report",
};

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
      canvases.push(canvas);
      return canvas;
    },
  });
});

afterEach(() => {
  canvases.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function makePdf() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) {
    const page = pdf.addPage([144, 72]);
    page.drawRectangle({
      x: 20,
      y: 10,
      width: 104,
      height: 52,
      color: i === 0 ? rgb(1, 0, 0) : rgb(0, 0, 1),
    });
    if (i === 2) page.setRotation(degrees(90));
  }
  return new File([new Uint8Array(await pdf.save())], "source.pdf", {
    type: "application/pdf",
  });
}

async function decode(bytes: ArrayBuffer | Uint8Array) {
  const image = await loadImage(Buffer.from(new Uint8Array(bytes)));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { image, context };
}

describe("PDF to images", () => {
  it.each(["jpg", "png"] as const)(
    "renders a single %s at 300 DPI with visible content and white background",
    async (format) => {
      // Display density must not change the dimensions of exported images.
      vi.stubGlobal("window", {
        devicePixelRatio: 3,
        requestAnimationFrame: (callback: FrameRequestCallback) =>
          setTimeout(() => callback(performance.now()), 0),
      });
      const result = await convertPdfToImages(await makePdf(), {
        ...options,
        format,
      });
      expect(result.filename).toBe(`report.${format}`);
      expect(result.fileCount).toBe(1);
      expect(result.blob.type).toBe(
        format === "jpg" ? "image/jpeg" : "image/png"
      );
      const { image, context } = await decode(await result.blob.arrayBuffer());
      expect([image.width, image.height]).toEqual([600, 300]);
      const center = [...context.getImageData(300, 150, 1, 1).data];
      expect(center[0]).toBeGreaterThan(245);
      expect(center[1]).toBeLessThan(10);
      expect(center[2]).toBeLessThan(10);
      expect([...context.getImageData(1, 1, 1, 1).data]).toEqual([
        255, 255, 255, 255,
      ]);
    }
  );

  it.each(["jpg", "png"] as const)(
    "packages selected %s pages once, in source order, with original page numbers and rotation",
    async (format) => {
      const progress: number[] = [];
      const packing: number[] = [];
      const result = await convertPdfToImages(await makePdf(), {
        ...options,
        format,
        pages: [3, 1, 3],
        outputName: "My:Report.zip",
        onProgress: (done) => progress.push(done),
        onPackingProgress: (percent) => packing.push(percent),
      });
      expect(result).toMatchObject({ filename: "My_Report.zip", fileCount: 2 });
      expect(result.blob.type).toBe("application/zip");
      const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
      expect(Object.keys(zip.files)).toEqual([
        `My_Report-page-01.${format}`,
        `My_Report-page-03.${format}`,
      ]);
      const first = await decode(
        await zip.file(`My_Report-page-01.${format}`)!.async("uint8array")
      );
      const third = await decode(
        await zip.file(`My_Report-page-03.${format}`)!.async("uint8array")
      );
      expect([first.image.width, first.image.height]).toEqual([600, 300]);
      expect([third.image.width, third.image.height]).toEqual([300, 600]);
      const blue = [...third.context.getImageData(150, 300, 1, 1).data];
      expect(blue[2]).toBeGreaterThan(245);
      expect(blue[0]).toBeLessThan(10);
      expect(progress).toEqual([1, 2]);
      expect(packing[0]).toBe(0);
      expect(packing.at(-1)).toBe(100);
    }
  );

  it.each([[], [0], [4], [1.5], [Number.NaN]].map((pages) => ({ pages })))(
    "rejects invalid page selection $pages",
    async ({ pages }) => {
      await expect(
        convertPdfToImages(await makePdf(), { ...options, pages })
      ).rejects.toThrow(/頁/);
      expect(canvases).toHaveLength(0);
    }
  );

  it("rejects too many images before rendering", async () => {
    await expect(
      convertPdfToImages(await makePdf(), {
        ...options,
        pages: Array.from(
          { length: IMAGE_CONVERSION_LIMITS.pages + 1 },
          (_, i) => i + 1
        ),
      })
    ).rejects.toThrow("最多可轉換 100 頁");
    expect(canvases).toHaveLength(0);
  });

  it("rejects oversized pages before allocating a bitmap", async () => {
    const document = await PDFDocument.create();
    document.addPage([10_000, 10_000]);
    const file = new File([new Uint8Array(await document.save())], "large.pdf");
    await expect(convertPdfToImages(file, options)).rejects.toThrow(
      "圖片尺寸過大"
    );
    expect(canvases).toHaveLength(0);
  });

  it("stops between pages without returning a partial archive", async () => {
    const controller = new AbortController();
    await expect(
      convertPdfToImages(await makePdf(), {
        ...options,
        pages: [1, 2],
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(canvases).toHaveLength(1);
  });

  it("can cancel ZIP packing", async () => {
    const controller = new AbortController();
    await expect(
      convertPdfToImages(await makePdf(), {
        ...options,
        pages: [1, 2],
        signal: controller.signal,
        onPackingProgress: (percent) => {
          if (percent > 0) controller.abort();
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("always encodes JPG photographs at maximum quality", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([144, 144]);
    const image = await pdf.embedJpg(
      readFileSync(new URL("./fixtures/source.jpg", import.meta.url))
    );
    page.drawImage(image, { x: 0, y: 0, width: 144, height: 144 });
    const file = new File([new Uint8Array(await pdf.save())], "photo.pdf");
    let highestQuality: Blob | null = null;
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = createCanvas(1, 1);
        const encode = canvas.toBlob.bind(canvas);
        canvas.toBlob = (callback, mime, quality) => {
          encode(
            (reference) => {
              highestQuality = reference;
              encode(callback, mime, quality);
            },
            mime,
            1
          );
        };
        return canvas;
      },
    });
    const result = await convertPdfToImages(file, options);
    expect(await result.blob.arrayBuffer()).toEqual(
      await highestQuality!.arrayBuffer()
    );
  });

  it("can cancel while the browser is encoding an image", async () => {
    const controller = new AbortController();
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = createCanvas(1, 1);
        canvas.toBlob = () => controller.abort();
        return canvas;
      },
    });
    await expect(
      convertPdfToImages(await makePdf(), {
        ...options,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails explicitly when the browser cannot encode the requested format", async () => {
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = createCanvas(1, 1);
        canvas.toBlob = (callback) => callback(null);
        return canvas;
      },
    });
    await expect(convertPdfToImages(await makePdf(), options)).rejects.toThrow(
      "無法產生圖片"
    );
  });

  it("normalizes output filenames", () => {
    expect(imageOutputStem(" My:Report.PNG ")).toBe("My_Report");
    expect(imageOutputStem("My:Report.PNG")).toBe("My_Report");
    expect(imageOutputStem("  ")).toBe("document");
  });
});
