import type { PDFPageProxy } from "pdfjs-dist";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

import type { AnalyzeOptions, RawPage } from "../types";
import { renderPage } from "./extractPage";
import { checkAbort, DOCX_LIMITS } from "./limits";
import { ocrSpans } from "./ocrGeometry";
import { horizontalTextPage, preferHorizontalText } from "./ocrLayout";
import { retainScanGraphics } from "./scanGraphics";
import { scanRules } from "./scanRules";

export class LocalOcr {
  private worker: Worker | null = null;
  private pending: Promise<Worker> | null = null;
  private disposed = false;
  private language = "";
  private rejectFailure: ((error: Error) => void) | undefined;
  constructor(private options: AnalyzeOptions) {}

  private async getWorker(): Promise<Worker> {
    if (!this.pending) {
      const base = new URL(
        `${import.meta.env.BASE_URL}ocr/`,
        window.location.href
      ).href;
      this.pending = createWorker(
        [this.options.language === "eng" ? "eng" : "chi_tra"],
        OEM.LSTM_ONLY,
        {
          workerPath: `${base}worker.min.js`,
          corePath: `${base}core/`,
          langPath: `${base}lang`,
          cachePath: "pdf-forge-ocr-v1",
          workerBlobURL: false,
          errorHandler: () =>
            this.rejectFailure?.(
              new Error(
                "本機 OCR 無法載入或執行，請確認本站辨識模型可下載後重試。"
              )
            ),
          logger: (message) =>
            this.options.onProgress?.({
              stage: "ocr",
              page: this.currentPage,
              total: this.totalPages,
              detail:
                message.status === "recognizing text"
                  ? `辨識文字 ${Math.round(message.progress * 100)}%`
                  : "載入本機辨識模型…",
            }),
        }
      ).then(async (worker) => {
        if (this.disposed || this.options.signal?.aborted) {
          await worker.terminate();
          checkAbort(this.options.signal);
          throw new Error("OCR 已關閉。");
        }
        this.worker = worker;
        this.language = this.options.language === "eng" ? "eng" : "chi_tra";
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.AUTO,
          user_defined_dpi: "216",
        });
        return worker;
      });
    }
    return this.pending;
  }
  private currentPage = 0;
  private totalPages = 0;

  async recognize(
    page: PDFPageProxy,
    raw: RawPage,
    total: number
  ): Promise<void> {
    this.currentPage = page.pageNumber;
    this.totalPages = total;
    const { canvas, scale } = await renderPage(page, 3, this.options.signal);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const original = context?.getImageData(0, 0, canvas.width, canvas.height);
    if (context) {
      raw.rules = scanRules(
        context.getImageData(0, 0, canvas.width, canvas.height),
        scale
      );
      // Keep the grid as geometry, then remove its long strokes from the OCR
      // input. Otherwise lines are read as |, _, or very tall character boxes.
      context.save();
      context.strokeStyle = "#ffffff";
      context.lineWidth = Math.max(3, scale * 2);
      for (const rule of raw.rules) {
        context.beginPath();
        context.moveTo(rule.x1 * scale, rule.y1 * scale);
        context.lineTo(rule.x2 * scale, rule.y2 * scale);
        context.stroke();
      }
      context.restore();
    }
    let rejectAbort: ((error: DOMException) => void) | undefined;
    const abort = () => {
      void this.dispose();
      rejectAbort?.(new DOMException("已取消處理。", "AbortError"));
    };
    this.options.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([
        (async () => {
          const worker = await this.getWorker();
          checkAbort(this.options.signal);
          const primaryLanguage =
            this.options.language === "eng" ? "eng" : "chi_tra";
          if (this.language !== primaryLanguage) {
            await worker.reinitialize(primaryLanguage, OEM.LSTM_ONLY);
            this.language = primaryLanguage;
            await worker.setParameters({
              tessedit_pageseg_mode: PSM.AUTO,
              user_defined_dpi: "216",
            });
          }
          const primary = (
            await worker.recognize(canvas, {}, { blocks: true, text: true })
          ).data;
          // Competing English character hypotheses degrade Traditional Chinese
          // scans. Start with Chinese; retry an English-dominant page locally.
          const text = primary.text ?? "";
          const latin = (text.match(/[a-z]/giu) ?? []).length;
          const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
          if (
            primaryLanguage === "chi_tra" &&
            latin >= 40 &&
            han < Math.max(4, latin / 8)
          ) {
            checkAbort(this.options.signal);
            await worker.reinitialize("eng", OEM.LSTM_ONLY);
            this.language = "eng";
            await worker.setParameters({
              tessedit_pageseg_mode: PSM.AUTO,
              user_defined_dpi: "216",
            });
            const fallback = (
              await worker.recognize(canvas, {}, { blocks: true, text: true })
            ).data;
            if (
              fallback.confidence >= primary.confidence &&
              fallback.text.length >= text.length * 0.8
            )
              return fallback;
          }
          if (
            this.language === "chi_tra" &&
            han >= 100 &&
            horizontalTextPage(primary.blocks ?? [], canvas.width, raw.rules)
          ) {
            checkAbort(this.options.signal);
            this.options.onProgress?.({
              stage: "ocr",
              page: this.currentPage,
              total: this.totalPages,
              detail: "核對橫向正文與清單標記…",
            });
            await worker.setParameters({
              tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
            });
            const fallback = (
              await worker.recognize(canvas, {}, { blocks: true, text: true })
            ).data;
            checkAbort(this.options.signal);
            await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
            if (preferHorizontalText(primary, fallback)) return fallback;
          }
          return primary;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.dispose();
            reject(
              new Error(
                `第 ${raw.number} 頁 OCR 超過 2 分鐘，請減少頁面或改用較清晰的原稿。`
              )
            );
          }, DOCX_LIMITS.ocrTimeoutMs);
          rejectAbort = reject;
          this.rejectFailure = reject;
          if (this.options.signal?.aborted) abort();
        }),
      ]);
      checkAbort(this.options.signal);
      raw.spans = ocrSpans(data.blocks ?? [], scale, raw.number);
      if (original)
        await retainScanGraphics(
          canvas,
          original,
          scale,
          raw,
          this.options.signal
        );
      raw.source = "ocr";
      raw.issues = raw.issues.filter(
        (issue) => issue.code !== "encoding" && issue.code !== "annotations"
      );
      raw.issues.push({
        page: raw.number,
        code: "ocr-review",
        severity: "review",
        message:
          "此頁使用本機 OCR，請核對文字、數字、表格及圖像範圍；掃描字型可能不同，複雜圖文仍可能誤判。",
      });
      if (!raw.spans.length)
        raw.issues.push({
          page: raw.number,
          code: "ocr-empty",
          severity: "error",
          message: "未辨識到可編輯文字，請確認原稿是否清晰或選擇正確語言。",
        });
      const low = raw.spans.filter(
        (span) => (span.confidence ?? 0) < 75
      ).length;
      if (low)
        raw.issues.push({
          page: raw.number,
          code: "ocr-confidence",
          severity: "review",
          message: `有 ${low} 個文字片段辨識信心較低，請逐一核對。`,
        });
    } finally {
      if (timer) clearTimeout(timer);
      this.rejectFailure = undefined;
      this.options.signal?.removeEventListener("abort", abort);
      canvas.width = canvas.height = 0;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      await worker.terminate();
    }
  }
}
