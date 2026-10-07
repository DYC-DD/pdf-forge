import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { unlockPdfWithEmptyPassword } from "./unlockPdf";

export async function openPdf(file: File, maxImagePixels?: number) {
  const [{ getDocument, GlobalWorkerOptions }, buffer] = await Promise.all([
    import("pdfjs-dist"),
    file.arrayBuffer(),
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const resourceBase = `${import.meta.env.BASE_URL}pdfjs/`;
  const resourceOptions = {
    cMapUrl: `${resourceBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${resourceBase}standard_fonts/`,
    wasmUrl: `${resourceBase}wasm/`,
    iccUrl: `${resourceBase}iccs/`,
    maxImageSize: maxImagePixels,
    canvasMaxAreaInBytes:
      maxImagePixels === undefined ? undefined : maxImagePixels * 4,
  };
  const task = getDocument({
    ...resourceOptions,
    data: new Uint8Array(buffer),
  });
  try {
    await task.promise;
    return task;
  } catch (error) {
    await task.destroy();
    if (
      !(error instanceof Error) ||
      !/password/i.test(`${error.name} ${error.message}`)
    )
      throw error;
    const bytes = await unlockPdfWithEmptyPassword(file);
    const retry = getDocument({
      ...resourceOptions,
      data: new Uint8Array(bytes),
    });
    try {
      await retry.promise;
      return retry;
    } catch (retryError) {
      await retry.destroy();
      throw retryError;
    }
  }
}

export type PdfThumbnail = {
  src: string;
  aspectRatio: number;
};

export async function renderPageThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  width = 360
): Promise<PdfThumbnail> {
  const page = await pdf.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  // Render enough pixels for grid cards, including high-density displays.
  const pixelRatio =
    typeof window === "undefined"
      ? 1
      : Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  // Bound both bitmap dimensions, even for unusual page sizes or aspect ratios.
  const viewport = page.getViewport({
    scale: Math.min(
      (width * pixelRatio) / original.width,
      2048 / original.width,
      2048 / original.height
    ),
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  try {
    await page.render({ canvas, viewport }).promise;
    return {
      src: canvas.toDataURL("image/png"),
      aspectRatio: original.width / original.height,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

export async function inspectPdf(
  file: File,
  validatePageCount?: (count: number) => string | null,
  maxImagePixels?: number
): Promise<{
  pageCount: number;
  thumbnail: string;
  thumbnailAspectRatio: number;
}> {
  const task = await openPdf(file, maxImagePixels);
  try {
    const pdf = await task.promise;
    const error = validatePageCount?.(pdf.numPages);
    if (error) throw new Error(error);
    const thumbnail = await renderPageThumbnail(pdf, 1);
    return {
      pageCount: pdf.numPages,
      thumbnail: thumbnail.src,
      thumbnailAspectRatio: thumbnail.aspectRatio,
    };
  } finally {
    await task.destroy();
  }
}
