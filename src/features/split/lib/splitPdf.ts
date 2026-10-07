import { fileStem } from "../../../shared/files/file";
import {
  pdfFileError,
  pdfPageCountError,
  splitPlanError,
} from "../../../shared/pdf/limits";
import { loadPdfDocument } from "../../../shared/pdf/loadPdfDocument";
import type { PageGroup, SplitOutput } from "../types";
import { resolveGroupFilenames } from "./resolveGroupFilenames";

export async function splitPdf(
  file: File,
  groups: PageGroup[],
  onProgress?: (done: number) => void,
  onPackingProgress?: (percent: number) => void
): Promise<SplitOutput> {
  if (groups.length === 0) throw new Error("請先選擇至少一組頁面。");
  const inputError = pdfFileError(file) ?? splitPlanError(groups);
  if (inputError) throw new Error(inputError);
  const { PDFDocument } = await import("pdf-lib");
  const source = await loadPdfDocument(file);
  const pageError = pdfPageCountError(source.getPageCount());
  if (pageError) throw new Error(pageError);
  const stem = fileStem(file.name);
  const zip = groups.length > 1 ? new (await import("jszip")).default() : null;
  const outputGroups = resolveGroupFilenames(file.name, groups);
  let singlePdf: Uint8Array | undefined;
  let singleFilename: string | undefined;

  for (let index = 0; index < groups.length; index += 1) {
    const group = outputGroups[index];
    if (
      group.pages.length === 0 ||
      group.pages.some(
        (page) =>
          !Number.isInteger(page) || page < 1 || page > source.getPageCount()
      )
    ) {
      throw new Error(`「${group.name}」的頁碼不正確。`);
    }
    const output = await PDFDocument.create();
    const pages = await output.copyPages(
      source,
      group.pages.map((page) => page - 1)
    );
    for (const page of pages) output.addPage(page);
    const bytes = new Uint8Array(await output.save());
    const name = `${group.filename}.pdf`;
    if (groups.length === 1) {
      singlePdf = bytes;
      singleFilename = name;
    } else if (zip) {
      zip.file(name, bytes);
    }
    onProgress?.(index + 1);
  }

  if (singlePdf && singleFilename) {
    return {
      blob: new Blob([new Uint8Array(singlePdf)], { type: "application/pdf" }),
      filename: singleFilename,
      fileCount: 1,
    };
  }
  if (!zip) throw new Error("無法建立拆分檔案。");
  return {
    blob: await zip.generateAsync(
      {
        type: "blob",
        compression: "STORE",
        streamFiles: true,
      },
      ({ percent }) => onPackingProgress?.(Math.floor(percent))
    ),
    filename: `${stem}-split.zip`,
    fileCount: groups.length,
  };
}
