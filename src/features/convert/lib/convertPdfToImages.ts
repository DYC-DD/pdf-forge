import type { PDFDocumentProxy } from "pdfjs-dist";

import { fileStem } from "../../../shared/files/file";
import { packImageZip } from "../../../shared/files/imageZip";
import { pdfFileError, pdfPageCountError } from "../../../shared/pdf/limits";
import { openPdf } from "../../../shared/pdf/preview";

export const IMAGE_CONVERSION_LIMITS = {
  pages: 100,
  pixelsPerPage: 16_000_000,
  edgePixels: 8192,
  outputBytes: 128 * 1024 * 1024,
} as const;

export type ImageFormat = "jpg" | "png";

const OUTPUT_DPI = 300;
const JPG_QUALITY = 1;

type ImageOptions = {
  pages: readonly number[];
  format: ImageFormat;
  outputName: string;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
  onPackingProgress?: (percent: number) => void;
};

function abortError() {
  return new DOMException("已取消轉換。", "AbortError");
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export function imagePageCountError(count: number): string | null {
  if (!Number.isInteger(count) || count < 1) return "請選擇至少一頁。";
  if (count > IMAGE_CONVERSION_LIMITS.pages) {
    return `一次最多可轉換 ${IMAGE_CONVERSION_LIMITS.pages} 頁，請分批選取頁面。`;
  }
  return null;
}

export function imageOutputStem(name: string): string {
  return fileStem(name.trim().replace(/\.(?:jpg|jpeg|png|zip)$/i, ""));
}

function encodeImage(
  canvas: HTMLCanvasElement,
  options: ImageOptions
): Promise<Blob> {
  const mime = options.format === "jpg" ? "image/jpeg" : "image/png";
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
      return;
    }
    try {
      canvas.toBlob(
        (blob) => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(abortError());
          else if (!blob || blob.type !== mime) {
            reject(new Error("無法產生圖片，請重新選取檔案後重試。"));
          } else resolve(blob);
        },
        mime,
        options.format === "jpg" ? JPG_QUALITY : undefined
      );
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

async function renderImage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  options: ImageOptions
): Promise<Blob> {
  const page = await pdf.getPage(pageNumber);
  let canvas: HTMLCanvasElement | undefined;
  let renderTask: ReturnType<typeof page.render> | undefined;
  const onAbort = () => renderTask?.cancel();
  try {
    checkCancelled(options.signal);
    const viewport = page.getViewport({ scale: OUTPUT_DPI / 72 });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1 ||
      width > IMAGE_CONVERSION_LIMITS.edgePixels ||
      height > IMAGE_CONVERSION_LIMITS.edgePixels ||
      width * height > IMAGE_CONVERSION_LIMITS.pixelsPerPage
    ) {
      throw new Error(
        `第 ${pageNumber} 頁的圖片尺寸過大，超過目前可轉換的單頁尺寸上限。`
      );
    }
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    renderTask = page.render({ canvas, viewport, background: "#ffffff" });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    await renderTask.promise;
    checkCancelled(options.signal);
    return await encodeImage(canvas, options);
  } catch (error) {
    checkCancelled(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    page.cleanup();
  }
}

export async function convertPdfToImages(file: File, options: ImageOptions) {
  checkCancelled(options.signal);
  const pages = [...new Set(options.pages)].sort((a, b) => a - b);
  const inputError = pdfFileError(file) ?? imagePageCountError(pages.length);
  if (inputError) throw new Error(inputError);
  if (!["jpg", "png"].includes(options.format)) {
    throw new Error("請選擇有效的圖片格式。");
  }

  const task = await openPdf(file);
  try {
    checkCancelled(options.signal);
    const pdf = await task.promise;
    const pageError = pdfPageCountError(pdf.numPages);
    if (pageError) throw new Error(pageError);
    if (
      pages.some(
        (page) => !Number.isInteger(page) || page < 1 || page > pdf.numPages
      )
    ) {
      throw new Error(`頁碼超出範圍，這份 PDF 共有 ${pdf.numPages} 頁。`);
    }
    const stem = imageOutputStem(options.outputName);
    const digits = Math.max(2, String(pdf.numPages).length);
    const zip = pages.length > 1 ? new (await import("jszip")).default() : null;
    let totalBytes = 0;
    let single: Blob | undefined;
    for (let index = 0; index < pages.length; index += 1) {
      checkCancelled(options.signal);
      const blob = await renderImage(pdf, pages[index], options);
      checkCancelled(options.signal);
      totalBytes += blob.size;
      if (totalBytes > IMAGE_CONVERSION_LIMITS.outputBytes) {
        throw new Error("圖片總大小超過 128 MB，請分批選取較少頁面。");
      }
      if (zip) {
        zip.file(
          `${stem}-page-${String(pages[index]).padStart(digits, "0")}.${options.format}`,
          await blob.arrayBuffer()
        );
      } else single = blob;
      options.onProgress?.(index + 1);
    }
    checkCancelled(options.signal);
    if (single) {
      return {
        blob: single,
        filename: `${stem}.${options.format}`,
        fileCount: 1,
      };
    }
    if (!zip) throw new Error("無法建立圖片檔案。");
    options.onPackingProgress?.(0);
    const blob = await packImageZip(
      zip,
      options.signal,
      options.onPackingProgress
    );
    checkCancelled(options.signal);
    return { blob, filename: `${stem}.zip`, fileCount: pages.length };
  } finally {
    await task.destroy();
  }
}
