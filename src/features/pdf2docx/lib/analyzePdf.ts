import { pdfPageCountError } from "../../../shared/pdf/limits";
import { openPdf } from "../../../shared/pdf/preview";
import type { AnalyzeOptions, DocumentModel, RawPage } from "../types";
import { captureFigures, extractPage } from "./extractPage";
import { checkAbort, DOCX_LIMITS, docxInputError } from "./limits";
import { runLayoutAnalysis } from "./runDocxJob";
import { normalizeOversizedScan } from "./scanPageSize";

export async function analyzePdf(
  file: File,
  pages?: readonly number[],
  settings: Partial<AnalyzeOptions> = {}
): Promise<DocumentModel> {
  const options: AnalyzeOptions = {
    ocr: "auto",
    language: "chi_tra+eng",
    preserveUncertainScan: false,
    ...settings,
  };
  checkAbort(options.signal);
  const error = docxInputError(file);
  if (error) throw new Error(error);
  if (pages && !pages.length) throw new Error("沒有可分析的頁面。");
  const task = await openPdf(file, DOCX_LIMITS.renderPixels);
  const abort = () => {
    void task.destroy();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const rawPages: RawPage[] = [];
  let ocr: import("./ocr").LocalOcr | undefined;
  let ocrBatchPages = 0,
    imageBytes = 0,
    layoutItems = 0;
  try {
    checkAbort(options.signal);
    const pdf = await task.promise;
    const pageError = pdfPageCountError(pdf.numPages);
    if (pageError) throw new Error(pageError);
    const selection = pages
      ? [...new Set(pages)].sort((a, b) => a - b)
      : Array.from({ length: pdf.numPages }, (_, index) => index + 1);
    if (
      selection.some(
        (page) => !Number.isInteger(page) || page < 1 || page > pdf.numPages
      )
    )
      throw new Error("選取頁碼超出文件範圍。");
    for (const number of selection) {
      checkAbort(options.signal);
      options.onProgress?.({
        stage: "read",
        page: number,
        total: selection.length,
      });
      checkAbort(options.signal);
      const page = await pdf.getPage(number);
      try {
        const { raw, imageBoxes } = await extractPage(page, options.signal);
        const visibleSpans = raw.spans.filter((span) => !span.hidden);
        // Searchable scans already contain invisible OCR text over a bitmap.
        // Flowing it as native text would print a second copy over the image.
        const searchableScan =
          raw.spans.some((span) => span.invisible) &&
          imageBoxes.some(
            (box) => box.width * box.height > raw.width * raw.height * 0.7
          );
        const embeddedPicture =
          visibleSpans.reduce((sum, span) => sum + span.text.trim().length, 0) <
            24 &&
          imageBoxes.some(
            (box) =>
              box.width * box.height > raw.width * raw.height * 0.15 &&
              box.width < raw.width * 0.9 &&
              box.height < raw.height * 0.94
          );
        const needsOcr =
          options.ocr === "always" ||
          (options.ocr === "auto" &&
            (searchableScan ||
              (!visibleSpans.length &&
                imageBoxes.length > 0 &&
                !embeddedPicture) ||
              (!visibleSpans.length &&
                (raw.rules.length > 0 ||
                  raw.issues.some((issue) => issue.severity === "review"))) ||
              raw.issues.some(
                (issue) =>
                  issue.code === "encoding" || issue.code === "annotations"
              )));
        if (needsOcr) {
          // Recycle the OCR worker between batches, without splitting the
          // document or losing the full-document layout context.
          if (ocrBatchPages === DOCX_LIMITS.ocrBatchPages) {
            await ocr?.dispose();
            ocr = undefined;
            ocrBatchPages = 0;
            checkAbort(options.signal);
          }
          if (!ocr) {
            const { LocalOcr } = await import("./ocr");
            ocr = new LocalOcr(options);
          }
          options.onProgress?.({
            stage: "ocr",
            page: number,
            total: selection.length,
          });
          await ocr.recognize(page, raw, selection.length);
          ocrBatchPages++;
          if (
            !raw.spans.length &&
            imageBoxes.length &&
            !raw.figures.some((figure) => figure.role === "scan-background")
          ) {
            raw.source = "pdf";
            raw.issues = raw.issues.filter(
              (issue) => issue.code !== "ocr-empty"
            );
            raw.issues.push({
              page: number,
              code: "image-only",
              severity: "info",
              message: "此頁未讀取到文字，已保留為可移動及縮放的圖片。",
            });
          }
        } else if (
          (searchableScan || !visibleSpans.length) &&
          imageBoxes.length &&
          !embeddedPicture
        )
          raw.issues.push({
            page: number,
            code: "scan",
            severity: "error",
            message: "此頁只有圖片，尚未完成辨識。請重新掃描文件。",
          });
        else if (
          !visibleSpans.length &&
          (raw.rules.length ||
            raw.issues.some((issue) => issue.severity === "review"))
        )
          raw.issues.push({
            page: number,
            code: "outlined-text",
            severity: "error",
            message: "此頁含圖形但沒有可讀取的文字，請重新掃描文件。",
          });
        // Independently embedded photos can still be retained after OCR. A full
        // scanned-page background is excluded to avoid duplicating its text.
        if (!raw.figures.some((figure) => figure.role === "scan-background"))
          await captureFigures(page, raw, imageBoxes, options.signal);
        if (
          raw.source === "pdf" &&
          imageBoxes.some(
            (box) => box.width * box.height > raw.width * raw.height * 0.35
          )
        )
          raw.issues.push({
            page: number,
            code: "mixed-page",
            severity: "review",
            message: "此頁的大面積圖片已保留，圖片中的文字無法直接編輯。",
          });
        imageBytes += raw.figures.reduce(
          (sum, figure) => sum + figure.data.byteLength,
          0
        );
        if (imageBytes > DOCX_LIMITS.imageBytes)
          throw new Error("保留的圖片總量超過 32 MB，請先拆分 PDF 後再轉換。");
        layoutItems +=
          raw.spans.length + raw.rules.length + (raw.fills?.length ?? 0);
        if (layoutItems > DOCX_LIMITS.layoutItems)
          throw new Error("文件內容過於複雜，請先拆分 PDF 後再轉換。");
        normalizeOversizedScan(raw);
        rawPages.push(raw);
      } finally {
        page.cleanup();
      }
      // Yield between pages, including when PDF.js serves an already-cached page.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await ocr?.dispose();
    ocr = undefined;
    checkAbort(options.signal);
    options.onProgress?.({
      stage: "layout",
      page: selection.length,
      total: selection.length,
    });
    return await runLayoutAnalysis(rawPages, options.signal);
  } catch (error) {
    checkAbort(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await ocr?.dispose();
    await task.destroy();
  }
}
