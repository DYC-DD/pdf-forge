import type { PageGroup } from "../../features/split/types";

const MiB = 1024 * 1024;

// Initial browser safety limits. Revisit these after testing large files on phones.
export const PDF_LIMITS = {
  fileBytes: 64 * MiB,
  mergeBytes: 160 * MiB,
  mergeFiles: 30,
  pagesPerFile: 600,
  mergePages: 900,
  splitFiles: 100,
  splitCopiedPages: 600,
} as const;

export function pdfFileError(file: File): string | null {
  if (!/\.pdf$/i.test(file.name)) return "請選擇 PDF 檔案。";
  if (file.size === 0) return "這份 PDF 是空的。";
  if (file.size > PDF_LIMITS.fileBytes) {
    return `單一 PDF 不可超過 ${PDF_LIMITS.fileBytes / MiB} MB。`;
  }
  return null;
}

export function mergeInputError(files: readonly File[]): string | null {
  if (files.length > PDF_LIMITS.mergeFiles) {
    return `一次最多可合併 ${PDF_LIMITS.mergeFiles} 份 PDF。`;
  }
  if (
    files.reduce((total, file) => total + file.size, 0) > PDF_LIMITS.mergeBytes
  ) {
    return `合併檔案的總大小不可超過 ${PDF_LIMITS.mergeBytes / MiB} MB。`;
  }
  return null;
}

export function pdfPageCountError(count: number): string | null {
  if (!Number.isInteger(count) || count < 1) return "PDF 沒有可處理的頁面。";
  if (count > PDF_LIMITS.pagesPerFile) {
    return `單一 PDF 最多可處理 ${PDF_LIMITS.pagesPerFile} 頁。`;
  }
  return null;
}

export function mergePageCountError(count: number): string | null {
  if (count > PDF_LIMITS.mergePages) {
    return `合併後最多可有 ${PDF_LIMITS.mergePages} 頁。`;
  }
  return null;
}

export function splitPlanError(groups: readonly PageGroup[]): string | null {
  if (groups.length > PDF_LIMITS.splitFiles) {
    return `一次最多可輸出 ${PDF_LIMITS.splitFiles} 份 PDF；請減少輸出組數。`;
  }
  const copiedPages = groups.reduce(
    (total, group) => total + group.pages.length,
    0
  );
  if (copiedPages > PDF_LIMITS.splitCopiedPages) {
    return `一次最多可輸出 ${PDF_LIMITS.splitCopiedPages} 頁；請減少重複選取的頁面。`;
  }
  return null;
}
