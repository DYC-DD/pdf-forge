import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { mergePdfs } from "../features/merge/lib/mergePdfs";
import { splitPdf } from "../features/split/lib/splitPdf";
import {
  mergeInputError,
  mergePageCountError,
  PDF_LIMITS,
  pdfFileError,
  pdfPageCountError,
  splitPlanError,
} from "../shared/pdf/limits";

function fileWithSize(name: string, size: number): File {
  const file = new File(["pdf"], name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("browser PDF limits", () => {
  it("accepts inputs above the former default limits", () => {
    const MiB = 1024 * 1024;
    expect(pdfFileError(fileWithSize("larger.pdf", 48 * MiB))).toBeNull();
    expect(pdfPageCountError(450)).toBeNull();
    expect(
      mergeInputError([
        fileWithSize("a.pdf", 48 * MiB),
        fileWithSize("b.pdf", 48 * MiB),
        fileWithSize("c.pdf", 48 * MiB),
      ])
    ).toBeNull();
    expect(mergePageCountError(750)).toBeNull();
    expect(
      splitPlanError([{ id: "a", name: "large", pages: Array(550).fill(1) }])
    ).toBeNull();
  });

  it("rejects empty, non-PDF, and oversized files before parsing", async () => {
    expect(pdfFileError(new File([], "empty.pdf"))).toContain("空的");
    expect(pdfFileError(fileWithSize("wrong.txt", 10))).toContain("PDF");
    const oversized = fileWithSize("large.pdf", PDF_LIMITS.fileBytes + 1);
    expect(pdfFileError(oversized)).toContain("單一 PDF");
    await expect(
      mergePdfs([oversized, fileWithSize("small.pdf", 10)])
    ).rejects.toThrow("單一 PDF");
  });

  it("checks merge totals and page counts", () => {
    expect(
      mergeInputError([
        fileWithSize("a.pdf", PDF_LIMITS.fileBytes),
        fileWithSize("b.pdf", PDF_LIMITS.fileBytes),
        fileWithSize("c.pdf", PDF_LIMITS.fileBytes),
        fileWithSize("d.pdf", 1),
      ])
    ).toContain("總大小");
    expect(pdfPageCountError(PDF_LIMITS.pagesPerFile + 1)).toContain("頁");
    expect(mergePageCountError(PDF_LIMITS.mergePages + 1)).toContain("頁");
  });

  it("rejects excessive split outputs before loading the PDF", async () => {
    const groups = Array.from(
      { length: PDF_LIMITS.splitFiles + 1 },
      (_, index) => ({
        id: String(index),
        name: String(index),
        pages: [1],
      })
    );
    expect(splitPlanError(groups)).toContain("份 PDF");
    await expect(
      splitPdf(fileWithSize("input.pdf", 10), groups)
    ).rejects.toThrow("份 PDF");
    expect(
      splitPlanError([
        {
          id: "many",
          name: "many",
          pages: Array(PDF_LIMITS.splitCopiedPages + 1).fill(1),
        },
      ])
    ).toContain("頁");
  });

  it("rejects a PDF with too many pages before copying any output", async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page <= PDF_LIMITS.pagesPerFile; page += 1) {
      document.addPage([100, 100]);
    }
    const file = new File([new Uint8Array(await document.save())], "many.pdf");
    await expect(
      splitPdf(file, [{ id: "first", name: "first", pages: [1] }])
    ).rejects.toThrow("單一 PDF 最多可處理");
  });
});
