import { loadPdfDocument } from "../../../shared/pdf/loadPdfDocument";

export async function mergePdfs(
  files: File[],
  onProgress?: (done: number) => void
): Promise<Blob> {
  if (files.length < 2) throw new Error("請至少加入兩份 PDF。");
  const { PDFDocument } = await import("pdf-lib");
  const output = await PDFDocument.create();
  for (let index = 0; index < files.length; index += 1) {
    const source = await loadPdfDocument(files[index]);
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
    onProgress?.(index + 1);
  }
  return new Blob([new Uint8Array(await output.save())], {
    type: "application/pdf",
  });
}
