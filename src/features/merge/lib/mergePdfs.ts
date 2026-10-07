import { copyPagesWithForms } from "../../../shared/pdf/copyPagesWithForms";
import {
  mergeInputError,
  mergePageCountError,
  pdfFileError,
  pdfPageCountError,
} from "../../../shared/pdf/limits";
import { loadPdfDocument } from "../../../shared/pdf/loadPdfDocument";

export async function mergePdfs(
  files: File[],
  onProgress?: (done: number) => void
): Promise<Blob> {
  if (files.length < 2) throw new Error("請至少加入兩份 PDF。");
  for (const file of files) {
    const error = pdfFileError(file);
    if (error) throw new Error(error);
  }
  const inputError = mergeInputError(files);
  if (inputError) throw new Error(inputError);
  const { PDFDocument } = await import("pdf-lib");
  const output = await PDFDocument.create();
  let totalPages = 0;
  for (let index = 0; index < files.length; index += 1) {
    const source = await loadPdfDocument(files[index]);
    const pageError = pdfPageCountError(source.getPageCount());
    if (pageError) throw new Error(pageError);
    totalPages += source.getPageCount();
    const totalError = mergePageCountError(totalPages);
    if (totalError) throw new Error(totalError);
    await copyPagesWithForms(source, output, source.getPageIndices());
    onProgress?.(index + 1);
  }
  return new Blob(
    [new Uint8Array(await output.save({ updateFieldAppearances: false }))],
    {
      type: "application/pdf",
    }
  );
}
