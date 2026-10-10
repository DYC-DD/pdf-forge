import { openPdf } from "../../../shared/pdf/preview";
import type { AnalyzeOptions, DocumentModel, RawPage } from "../types";
import { captureFigures, extractPage } from "./extractPage";
import { checkAbort, DOCX_LIMITS, docxInputError } from "./limits";
import { runLayoutAnalysis } from "./runDocxJob";

export async function analyzePdf(
  file: File,
  pages: readonly number[],
  options: AnalyzeOptions
): Promise<DocumentModel> {
  checkAbort(options.signal);
  const error = docxInputError(file);
  if (error) throw new Error(error);
  const selection = [...new Set(pages)].sort((a, b) => a - b);
  if (!selection.length || selection.length > DOCX_LIMITS.pages)
    throw new Error("一次請選取 1～50 頁進行分析。");
  const task = await openPdf(file, DOCX_LIMITS.renderPixels);
  const abort = () => {
    void task.destroy();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const rawPages: RawPage[] = [];
  let ocr: import("./ocr").LocalOcr | undefined;
  let ocrPages = 0,
    imageBytes = 0;
  try {
    checkAbort(options.signal);
    const pdf = await task.promise;
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
      const page = await pdf.getPage(number);
      try {
        const { raw, imageBoxes } = await extractPage(page, options.signal);
        const embeddedPicture =
          raw.spans.reduce((sum, span) => sum + span.text.trim().length, 0) <
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
            ((!raw.spans.length && imageBoxes.length > 0 && !embeddedPicture) ||
              raw.issues.some(
                (issue) =>
                  issue.code === "encoding" || issue.code === "annotations"
              )));
        if (needsOcr) {
          if (++ocrPages > DOCX_LIMITS.ocrPages)
            throw new Error("一次最多辨識 10 頁掃描頁面，請分批選取。");
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
          if (!raw.spans.length && imageBoxes.length) {
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
        } else if (!raw.spans.length && imageBoxes.length && !embeddedPicture)
          raw.issues.push({
            page: number,
            code: "scan",
            severity: "error",
            message: "此頁只有圖片，請啟用本機 OCR 後重新分析。",
          });
        else if (
          !raw.spans.length &&
          (raw.rules.length ||
            raw.issues.some((issue) => issue.severity === "review"))
        )
          raw.issues.push({
            page: number,
            code: "outlined-text",
            severity: "error",
            message: "此頁含圖形但沒有可讀取的文字，請改用「整頁重新辨識」。",
          });
        // Independently embedded photos can still be retained after OCR. A full
        // scanned-page background is excluded to avoid duplicating its text.
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
            message:
              "此頁含大面積圖片，圖片內文字可能未被讀取；必要時使用「整頁重新辨識」。",
          });
        imageBytes += raw.figures.reduce(
          (sum, figure) => sum + figure.data.byteLength,
          0
        );
        if (imageBytes > DOCX_LIMITS.imageBytes)
          throw new Error("保留的圖片總量超過 32 MB，請分批選取頁面。");
        rawPages.push(raw);
      } finally {
        page.cleanup();
      }
      // Yield between pages, including when PDF.js serves an already-cached page.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
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
