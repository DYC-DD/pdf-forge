import { fileStem } from "../../../shared/files/file";
import { loadPdfDocument } from "../../../shared/pdf/loadPdfDocument";
import type { PageGroup, SplitOutput } from "../types";

export async function splitPdf(
  file: File,
  groups: PageGroup[],
  onProgress?: (done: number) => void
): Promise<SplitOutput> {
  if (groups.length === 0) throw new Error("請先選擇至少一組頁面。");
  const [{ PDFDocument }, { default: JSZip }] = await Promise.all([
    import("pdf-lib"),
    import("jszip"),
  ]);
  const source = await loadPdfDocument(file);
  const stem = fileStem(file.name);
  const zip = new JSZip();
  const usedNames = new Set<string>();
  let singlePdf: Uint8Array | undefined;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (
      group.pages.length === 0 ||
      group.pages.some((page) => page < 1 || page > source.getPageCount())
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
    const label = fileStem(group.name) || `part-${index + 1}`;
    let name = `${stem}-${label}.pdf`;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${stem}-${label}-${suffix}.pdf`;
      suffix += 1;
    }
    usedNames.add(name.toLowerCase());
    if (groups.length === 1) singlePdf = bytes;
    else zip.file(name, bytes);
    onProgress?.(index + 1);
  }

  if (singlePdf) {
    return {
      blob: new Blob([new Uint8Array(singlePdf)], { type: "application/pdf" }),
      filename: [...usedNames][0],
      fileCount: 1,
    };
  }
  return {
    blob: await zip.generateAsync({
      type: "blob",
      compression: "STORE",
      streamFiles: true,
    }),
    filename: `${stem}-split.zip`,
    fileCount: groups.length,
  };
}
