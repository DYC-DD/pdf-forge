import type { PDFPageProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DOCX_LIMITS } from "../features/pdf2docx/lib/limits";
import { LocalOcr } from "../features/pdf2docx/lib/ocr";
import type { RawPage } from "../features/pdf2docx/types";

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
  parameters: vi.fn(),
  reinitialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("tesseract.js", () => ({
  createWorker: mock.create,
  OEM: { LSTM_ONLY: 1 },
  PSM: { AUTO: 3, SINGLE_BLOCK: 6 },
}));
vi.mock("../features/pdf2docx/lib/extractPage", () => ({
  renderPage: mock.render,
}));
const worker = {
  recognize: mock.recognize,
  terminate: mock.terminate,
  setParameters: mock.parameters,
  reinitialize: mock.reinitialize,
};
const source = { pageNumber: 1 } as PDFPageProxy;
const canvas = { width: 600, height: 800, getContext: () => null };
function page(): RawPage {
  return {
    number: 1,
    width: 200,
    height: 267,
    source: "pdf",
    rules: [],
    figures: [],
    spans: [],
    issues: [
      { page: 1, code: "encoding", message: "bad mapping", severity: "error" },
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { href: "https://tools.example/pdf-forge/pdf2docx/" },
  });
  vi.stubEnv("BASE_URL", "/pdf-forge/");
  vi.clearAllMocks();
  mock.create.mockResolvedValue(worker);
  mock.parameters.mockResolvedValue(undefined);
  mock.terminate.mockResolvedValue(undefined);
  canvas.width = 600;
  canvas.height = 800;
  mock.render.mockResolvedValue({ canvas, scale: 3 });
  mock.recognize.mockResolvedValue({
    data: {
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  baseline: { y0: 90, y1: 90 },
                  bbox: { x0: 30, y0: 60, x1: 250, y1: 90 },
                  words: [
                    {
                      text: "繁體中文",
                      confidence: 94,
                      bbox: { x0: 30, y0: 60, x1: 150, y1: 90 },
                    },
                    {
                      text: "12345",
                      confidence: 60,
                      bbox: { x0: 160, y0: 45, x1: 250, y1: 105 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("browser-local OCR", () => {
  it("loads the worker, WASM and language models from the same site, reuses the worker and frees it", async () => {
    const progress = vi.fn(),
      ocr = new LocalOcr({
        ocr: "auto",
        language: "chi_tra+eng",
        onProgress: progress,
      });
    const raw = page();
    await ocr.recognize(source, raw, 2);
    await ocr.recognize(source, page(), 2);
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.create).toHaveBeenCalledWith(
      ["chi_tra"],
      1,
      expect.objectContaining({
        workerPath: "https://tools.example/pdf-forge/ocr/worker.min.js",
        corePath: "https://tools.example/pdf-forge/ocr/core/",
        langPath: "https://tools.example/pdf-forge/ocr/lang",
        workerBlobURL: false,
      })
    );
    expect(mock.recognize).toHaveBeenCalledWith(
      canvas,
      {},
      { blocks: true, text: true }
    );
    expect(raw.spans[0]).toMatchObject({
      text: "繁體中文",
      x: 10,
      y: 20,
      width: 40,
      height: 10,
      source: "ocr",
    });
    expect(raw.spans[0].size).toBeCloseTo(10 / 0.9);
    expect(raw.spans[1].height).toBe(10);
    expect(raw.issues.some((issue) => issue.code === "encoding")).toBe(false);
    expect(raw.issues).toContainEqual(
      expect.objectContaining({ code: "ocr-confidence", severity: "review" })
    );
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    await ocr.dispose();
    await ocr.dispose();
    expect(mock.terminate).toHaveBeenCalledTimes(1);
  });
  it("retries English-dominant pages and restores Chinese before the next page", async () => {
    const blocks = (text: string) => [
      {
        paragraphs: [
          {
            lines: [
              {
                baseline: { y0: 90, y1: 90 },
                bbox: { x0: 30, y0: 60, x1: 250, y1: 90 },
                words: [
                  {
                    text,
                    confidence: 95,
                    bbox: { x0: 30, y0: 60, x1: 250, y1: 90 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const text =
      "An English document with enough Latin letters to select its own recognition model.";
    mock.recognize
      .mockResolvedValueOnce({
        data: { text, confidence: 70, blocks: blocks(text) },
      })
      .mockResolvedValueOnce({
        data: { text, confidence: 95, blocks: blocks(text) },
      })
      .mockResolvedValueOnce({
        data: {
          text: "繁體中文文件",
          confidence: 95,
          blocks: blocks("繁體中文文件"),
        },
      });
    const ocr = new LocalOcr({ ocr: "auto", language: "chi_tra+eng" });
    await ocr.recognize(source, page(), 2);
    const chinese = page();
    await ocr.recognize(source, chinese, 2);
    expect(mock.reinitialize.mock.calls).toEqual([
      ["eng", 1],
      ["chi_tra", 1],
    ]);
    expect(chinese.spans[0].text).toBe("繁體中文文件");
    await ocr.dispose();
  });
  it("keeps the primary result when the English retry loses content", async () => {
    const primary = {
      text: "English letters in a long sentence that should remain available after recognition.",
      confidence: 85,
      blocks: [],
    };
    mock.recognize
      .mockResolvedValueOnce({ data: primary })
      .mockResolvedValueOnce({
        data: { text: "Lost content", confidence: 95, blocks: [] },
      });
    const ocr = new LocalOcr({ ocr: "auto", language: "chi_tra+eng" });
    await ocr.recognize(source, page(), 1);
    expect(mock.reinitialize).toHaveBeenCalledWith("eng", 1);
    expect(mock.recognize).toHaveBeenCalledTimes(2);
    await ocr.dispose();
  });
  it("retries dense horizontal Chinese text and restores automatic segmentation for the next page", async () => {
    const text = "一、繁體中文正文內容。".repeat(24);
    const blocks = (marker: string) => [
      {
        paragraphs: [
          {
            lines: Array.from({ length: 24 }, (_, i) => ({
              baseline: { x0: 30, x1: 550, y0: 60 + i * 20, y1: 60 + i * 20 },
              bbox: { x0: 30, y0: 45 + i * 20, x1: 550, y1: 60 + i * 20 },
              words: [
                {
                  text: marker,
                  confidence: 95,
                  bbox: { x0: 30, y0: 45 + i * 20, x1: 550, y1: 60 + i * 20 },
                },
              ],
            })),
          },
        ],
      },
    ];
    mock.recognize
      .mockResolvedValueOnce({
        data: { text, confidence: 85, blocks: blocks("錯誤標記") },
      })
      .mockResolvedValueOnce({
        data: { text, confidence: 90, blocks: blocks("一、正文") },
      });
    const ocr = new LocalOcr({ ocr: "auto", language: "chi_tra+eng" });
    const raw = page();
    await ocr.recognize(source, raw, 2);
    await ocr.recognize(source, page(), 2);
    expect(raw.spans[0].text).toBe("一、正文");
    expect(
      mock.parameters.mock.calls.map(([p]) => p.tessedit_pageseg_mode)
    ).toEqual([3, 6, 3]);
    expect(mock.recognize).toHaveBeenCalledTimes(3);
    expect(mock.reinitialize).not.toHaveBeenCalled();
    await ocr.dispose();
  });
  it("cancels during model initialization and terminates a late worker without recognizing", async () => {
    let initialized!: (value: typeof worker) => void;
    mock.create.mockReturnValue(
      new Promise((resolve) => {
        initialized = resolve;
      })
    );
    const controller = new AbortController(),
      ocr = new LocalOcr({
        ocr: "auto",
        language: "eng",
        signal: controller.signal,
      });
    const result = ocr.recognize(source, page(), 1);
    await vi.waitFor(() => expect(mock.create).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    initialized(worker);
    await vi.waitFor(() => expect(mock.terminate).toHaveBeenCalledOnce());
    expect(mock.recognize).not.toHaveBeenCalled();
    expect(canvas.width).toBe(0);
  });
  it("terminates a stalled recognition at the deadline", async () => {
    vi.useFakeTimers();
    mock.recognize.mockReturnValue(new Promise(() => {}));
    const ocr = new LocalOcr({ ocr: "auto", language: "eng" });
    const result = ocr.recognize(source, page(), 1),
      rejection = expect(result).rejects.toThrow("超過 2 分鐘");
    await vi.advanceTimersByTimeAsync(DOCX_LIMITS.ocrTimeoutMs);
    await rejection;
    expect(mock.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(canvas.width).toBe(0);
  });
  it("reports model loading errors without waiting for the timeout", async () => {
    mock.create.mockReturnValue(new Promise(() => {}));
    const ocr = new LocalOcr({ ocr: "auto", language: "eng" });
    const result = ocr.recognize(source, page(), 1);
    await vi.waitFor(() => expect(mock.create).toHaveBeenCalledOnce());
    mock.create.mock.calls[0][2].errorHandler("Failed to fetch language model");
    await expect(result).rejects.toThrow("辨識模型");
    expect(canvas.width).toBe(0);
    await ocr.dispose();
  });
});
