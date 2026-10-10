export const DOCX_LIMITS = {
  fileBytes: 32 * 1024 * 1024,
  pages: 50,
  ocrPages: 10,
  spansPerPage: 25_000,
  operatorsPerPage: 100_000,
  rulesPerPage: 2_000,
  imageBytes: 32 * 1024 * 1024,
  renderPixels: 8_000_000,
  renderEdge: 4096,
  workerTimeoutMs: 120_000,
  ocrTimeoutMs: 120_000,
} as const;

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("已取消處理。", "AbortError");
}

export function docxInputError(file: File): string | null {
  if (!/\.pdf$/i.test(file.name)) return "請選擇 PDF 檔案。";
  if (!file.size) return "這份 PDF 是空的。";
  if (file.size > DOCX_LIMITS.fileBytes)
    return "PDF2docx 一次最多處理 32 MB，請先拆分較大的文件。";
  return null;
}
