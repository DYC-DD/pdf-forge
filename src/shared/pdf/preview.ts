import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { unlockPdfWithEmptyPassword } from "./unlockPdf";

export async function openPdf(file: File) {
  const [{ getDocument, GlobalWorkerOptions }, buffer] = await Promise.all([
    import("pdfjs-dist"),
    file.arrayBuffer(),
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({ data: new Uint8Array(buffer) });
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
    const retry = getDocument({ data: new Uint8Array(bytes) });
    try {
      await retry.promise;
      return retry;
    } catch (retryError) {
      await retry.destroy();
      throw retryError;
    }
  }
}

export async function renderPageThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  width: number
): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / original.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  try {
    await page.render({ canvas, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

export async function inspectPdf(
  file: File,
  validatePageCount?: (count: number) => string | null
): Promise<{ pageCount: number; thumbnail: string }> {
  const task = await openPdf(file);
  try {
    const pdf = await task.promise;
    const error = validatePageCount?.(pdf.numPages);
    if (error) throw new Error(error);
    return {
      pageCount: pdf.numPages,
      thumbnail: await renderPageThumbnail(pdf, 1, 116),
    };
  } finally {
    await task.destroy();
  }
}
