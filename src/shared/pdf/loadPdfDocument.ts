import { isEncryptedPdfError, unlockPdfWithEmptyPassword } from "./unlockPdf";

export async function loadPdfDocument(file: File) {
  const { PDFDocument } = await import("pdf-lib");
  try {
    return await PDFDocument.load(await file.arrayBuffer());
  } catch (error) {
    if (!isEncryptedPdfError(error)) throw error;
    return PDFDocument.load(await unlockPdfWithEmptyPassword(file));
  }
}
