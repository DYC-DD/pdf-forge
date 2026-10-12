import type { PDFPageProxy } from "pdfjs-dist";
import { beforeEach, expect, it, vi } from "vitest";

import { analyzePdf } from "../features/pdf2docx/lib/analyzePdf";
import { DOCX_LIMITS } from "../features/pdf2docx/lib/limits";
import type { AnalyzeOptions, RawPage } from "../features/pdf2docx/types";

const fixture = vi.hoisted(() => ({
  count: 25,
  failPage: 0,
  outline: false,
  imageBytes: 1,
  itemCount: 0,
  destroy: vi.fn(),
  cleanup: vi.fn(),
  workers: [] as {
    pages: number[];
    disposed: boolean;
    options: AnalyzeOptions;
  }[],
}));

vi.mock("../shared/pdf/preview", () => ({
  openPdf: async () => ({
    destroy: fixture.destroy,
    promise: Promise.resolve({
      numPages: fixture.count,
      getPage: async (pageNumber: number) => ({
        pageNumber,
        cleanup: fixture.cleanup,
      }),
    }),
  }),
}));
vi.mock("../features/pdf2docx/lib/extractPage", () => ({
  extractPage: async (page: PDFPageProxy) => ({
    raw: {
      number: page.pageNumber,
      width: 595,
      height: 842,
      source: "pdf",
      spans: [],
      rules: [],
      figures: [],
      issues: fixture.outline
        ? [
            {
              page: page.pageNumber,
              code: "vector-art",
              severity: "review",
              message: "Vector content",
            },
          ]
        : [],
    },
    imageBoxes: fixture.outline
      ? []
      : [{ x: 0, y: 0, width: 595, height: 842 }],
  }),
  captureFigures: vi.fn(),
}));
vi.mock("../features/pdf2docx/lib/ocr", () => ({
  LocalOcr: class {
    state: (typeof fixture.workers)[number];
    constructor(options: AnalyzeOptions) {
      this.state = { pages: [], disposed: false, options };
      fixture.workers.push(this.state);
    }
    async recognize(page: PDFPageProxy, raw: RawPage) {
      if (this.state.disposed) throw new Error("Disposed worker reused");
      this.state.pages.push(page.pageNumber);
      if (fixture.failPage === page.pageNumber) throw new Error("OCR failed");
      raw.source = "ocr";
      raw.figures = [
        {
          id: `scan-${page.pageNumber}`,
          x: 0,
          y: 0,
          width: 595,
          height: 842,
          data: new Uint8Array(fixture.imageBytes),
          role: "scan-background",
        },
      ];
      raw.fills = Array.from({ length: fixture.itemCount }, () => ({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        color: "FFFFFF",
      }));
    }
    async dispose() {
      this.state.disposed = true;
    }
  },
}));

beforeEach(() => {
  fixture.count = 25;
  fixture.failPage = 0;
  fixture.outline = false;
  fixture.imageBytes = 1;
  fixture.itemCount = 0;
  fixture.workers = [];
  vi.clearAllMocks();
});
const file = new File(["private fixture stub"], "document.pdf");

it("automatically processes all 25 scans with bounded OCR worker lifetimes", async () => {
  const progress = vi.fn();
  const model = await analyzePdf(file, undefined, { onProgress: progress });
  expect(model.pages.map((page) => page.number)).toEqual(
    Array.from({ length: 25 }, (_, index) => index + 1)
  );
  expect(model.stats).toMatchObject({ pages: 25, ocrPages: 25, images: 25 });
  expect(fixture.workers.map((worker) => worker.pages.length)).toEqual([
    10, 10, 5,
  ]);
  for (const worker of fixture.workers) {
    expect(worker.disposed).toBe(true);
    expect(worker.options).toMatchObject({
      ocr: "auto",
      language: "chi_tra+eng",
      preserveUncertainScan: false,
    });
  }
  expect(progress.mock.calls.every(([value]) => value.total === 25)).toBe(true);
  expect(fixture.cleanup).toHaveBeenCalledTimes(25);
  expect(fixture.destroy).toHaveBeenCalledTimes(1);
});

it("can cancel at a batch boundary without returning a partial document", async () => {
  const controller = new AbortController();
  await expect(
    analyzePdf(file, undefined, {
      signal: controller.signal,
      onProgress: ({ stage, page }) => {
        if (stage === "read" && page === 11) controller.abort();
      },
    })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.workers).toHaveLength(1);
  expect(fixture.workers[0].disposed).toBe(true);
  expect(fixture.cleanup).toHaveBeenCalledTimes(10);
  expect(fixture.destroy).toHaveBeenCalled();
});

it("cleans up a failed later OCR batch and can scan the whole document again", async () => {
  fixture.failPage = 11;
  await expect(analyzePdf(file)).rejects.toThrow("OCR failed");
  expect(fixture.workers.every((worker) => worker.disposed)).toBe(true);
  expect(fixture.cleanup).toHaveBeenCalledTimes(11);
  fixture.failPage = 0;
  const model = await analyzePdf(file);
  expect(model.stats.pages).toBe(25);
  expect(fixture.workers.every((worker) => worker.disposed)).toBe(true);
});

it("uses automatic OCR for outlined content without asking for a recognition mode", async () => {
  fixture.count = 1;
  fixture.outline = true;
  const model = await analyzePdf(file);
  expect(model.stats).toMatchObject({ pages: 1, images: 1, ocrPages: 1 });
  expect(model.issues.some((issue) => issue.severity === "error")).toBe(false);
});

it("enforces the image budget across OCR batches, not separately for each batch", async () => {
  fixture.imageBytes = 3 * 1024 * 1024;
  await expect(analyzePdf(file)).rejects.toThrow("圖片總量超過 32 MB");
  expect(fixture.workers.map((worker) => worker.pages.length)).toEqual([10, 1]);
  expect(fixture.workers.every((worker) => worker.disposed)).toBe(true);
  expect(fixture.destroy).toHaveBeenCalledTimes(1);
});

it("bounds accumulated layout data for long documents", async () => {
  fixture.itemCount = Math.floor(DOCX_LIMITS.layoutItems / 2) + 1;
  await expect(analyzePdf(file)).rejects.toThrow("文件內容過於複雜");
  expect(fixture.cleanup).toHaveBeenCalledTimes(2);
  expect(fixture.workers.every((worker) => worker.disposed)).toBe(true);
});

it("rejects a source above the shared page limit before starting OCR", async () => {
  fixture.count = 601;
  await expect(analyzePdf(file)).rejects.toThrow("600 頁");
  expect(fixture.workers).toHaveLength(0);
  expect(fixture.destroy).toHaveBeenCalledTimes(1);
});
