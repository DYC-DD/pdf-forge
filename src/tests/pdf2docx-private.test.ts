import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzePdf } from "../features/pdf2docx/lib/analyzePdf";
import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { paragraphText } from "../features/pdf2docx/lib/paragraphs";
import type { RawPage } from "../features/pdf2docx/types";
import { openPdf } from "../shared/pdf/preview";
import { decodeXmlText, docxEditableText } from "./helpers/pdf2docx-docx-text";

const observed = vi.hoisted(() => ({ pages: [] as RawPage[] }));
vi.mock("../features/pdf2docx/lib/layout", async (importOriginal) => {
  const module =
    await importOriginal<typeof import("../features/pdf2docx/lib/layout")>();
  return {
    ...module,
    analyzeLayout: (pages: RawPage[]) => {
      observed.pages = pages;
      return module.analyzeLayout(pages);
    },
  };
});

vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL(
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url
  ).href,
}));
// Exercise the real browser pipeline and OCR model. Only bridge the browser
// canvas and worker paths to their Node equivalents; never upload fixtures.
vi.mock("tesseract.js", async (importOriginal) => {
  const module = await importOriginal<typeof import("tesseract.js")>();
  return {
    ...module,
    createWorker: async (languages: string[], oem: number, options: object) => {
      const localOptions = { ...options } as Record<string, unknown>;
      delete localOptions.workerPath;
      delete localOptions.corePath;
      const worker = await module.createWorker(languages, oem, {
        ...localOptions,
        langPath: resolve("public/ocr/lang"),
        cacheMethod: "none",
      });
      const recognize = worker.recognize.bind(worker);
      let crop = 0;
      worker.recognize = async (image, ...args) => {
        const input = image as unknown as {
          toBuffer: (mime: string) => Buffer;
          width: number;
          height: number;
        };
        const bytes = input.toBuffer("image/png");
        const result = await recognize(bytes, ...args);
        if (
          process.env.PDF2DOCX_QA_CROPS &&
          input.height < 400 &&
          ++crop <= 120
        ) {
          const path = resolve(process.env.PDF2DOCX_QA_CROPS);
          await mkdir(path, { recursive: true });
          await writeFile(resolve(path, `${crop}.png`), bytes);
          await writeFile(
            resolve(path, `${crop}.json`),
            JSON.stringify(result.data)
          );
        }
        return result;
      };
      return worker;
    },
  };
});

const manifest =
  process.env.PDF2DOCX_CORPUS_MANIFEST ?? process.env.PDF2DOCX_PRIVATE_MANIFEST;
const output = process.env.PDF2DOCX_QA_DIR;
// Optional local fonts align the Node canvas with the render host; font files
// and private fixture paths never become checked-in test assets.
for (const font of (process.env.PDF2DOCX_QA_FONTS ?? "")
  .split(":")
  .filter(Boolean))
  if (!GlobalFonts.registerFromPath(font))
    throw new Error(`Cannot load QA font: ${font}`);
const samples: {
  id: string;
  path: string;
  sha256?: string;
  sourcePageCount?: number;
  pages?: number[];
  minimumEditableCharacters?: number;
  minimumTables?: number;
  maximumOcrPages?: number;
  minimumRotatedCells?: number;
  minimumLargestTableColumns?: number;
  minimumLargestTableRows?: number;
  expectedText?: string[];
  unexpectedText?: string[];
  minimumPreservedRegions?: number;
  requiredReviewCodes?: string[];
  requiredNumberingColors?: string[];
  requiredBoldText?: string[];
  requiredItalicText?: string[];
  expectedColumns?: { page: number; text: string[][] }[];
  minimumRaisedRuns?: number;
  minimumGraphicRegions?: number;
}[] = manifest ? JSON.parse(await readFile(resolve(manifest), "utf8")) : [];

beforeEach(async () => {
  observed.pages = [];
  // Resolve Tesseract's environment before installing the canvas DOM shim.
  await import("tesseract.js");
  vi.stubEnv(
    "BASE_URL",
    fileURLToPath(new URL("../../public/", import.meta.url))
  );
  vi.stubGlobal("window", {
    location: { href: "file:///" },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  });
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = createCanvas(1, 1);
      Object.assign(canvas, {
        toBlob: (callback: (blob: Blob) => void, mime = "image/png") =>
          callback(
            new Blob([new Uint8Array(canvas.toBuffer(mime as "image/png"))], {
              type: mime,
            })
          ),
      });
      return canvas;
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.skipIf(!manifest)("PDF corpus (opt in, local only)", () => {
  it.each(samples)(
    "converts $id",
    async ({
      id,
      path,
      sha256,
      sourcePageCount,
      pages,
      minimumEditableCharacters = 0,
      minimumTables = 0,
      maximumOcrPages = Infinity,
      minimumRotatedCells = 0,
      minimumLargestTableColumns = 0,
      minimumLargestTableRows = 0,
      expectedText = [],
      unexpectedText = [],
      minimumPreservedRegions = 0,
      requiredReviewCodes = [],
      requiredNumberingColors = [],
      requiredBoldText = [],
      requiredItalicText = [],
      expectedColumns = [],
      minimumRaisedRuns = 0,
      minimumGraphicRegions = 0,
    }) => {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      const bytes = await readFile(path);
      if (sha256)
        expect(
          createHash("sha256").update(bytes).digest("hex"),
          "upstream fixture changed"
        ).toBe(sha256);
      const file = new File([bytes], `${id}.pdf`, { type: "application/pdf" });
      const task = await openPdf(file);
      let selection: number[];
      try {
        const pdf = await task.promise;
        if (sourcePageCount !== undefined)
          expect(pdf.numPages, "source page count changed").toBe(
            sourcePageCount
          );
        selection =
          pages ?? Array.from({ length: pdf.numPages }, (_, i) => i + 1);
      } finally {
        await task.destroy();
      }
      // The same whole-document defaults as the UI; no test-side OCR batching.
      const model = await analyzePdf(file, pages, {
        onProgress: ({ stage, page, detail }) => {
          if (!detail) console.log(id, stage, page);
        },
      });
      expect(
        model.issues.filter((issue) => issue.severity === "error")
      ).toEqual([]);
      expect(model.pages.map((page) => page.number)).toEqual(selection);
      for (const code of requiredReviewCodes)
        expect(
          model.issues.some(
            (issue) => issue.code === code && issue.severity === "review"
          ),
          `Missing review notice: ${code}`
        ).toBe(true);
      for (const check of expectedColumns) {
        const page = model.pages.find((page) => page.number === check.page);
        const groups =
          page?.groups.filter(
            (group) => group.columns.length === check.text.length
          ) ?? [];
        const normalize = (text: string) =>
          text.normalize("NFKC").replace(/\s/gu, "");
        expect(
          groups.some((group) =>
            check.text.every((snippets, index) => {
              const text = normalize(
                group.columns[index]
                  .filter((block) => block.kind === "paragraph")
                  .map(paragraphText)
                  .join("")
              );
              return snippets.every((snippet) =>
                text.includes(normalize(snippet))
              );
            })
          ),
          `Missing independent columns on source page ${check.page}`
        ).toBe(true);
      }
      const tables = model.pages
        .flatMap((p) => p.groups.flatMap((g) => g.columns.flat()))
        .filter((b) => b.kind === "table");
      expect(
        tables.flatMap((t) => t.cells).filter((c) => c.rotation).length
      ).toBeGreaterThanOrEqual(minimumRotatedCells);
      expect(
        Math.max(0, ...tables.map((t) => t.columns.length))
      ).toBeGreaterThanOrEqual(minimumLargestTableColumns);
      expect(
        Math.max(0, ...tables.map((table) => table.rows.length))
      ).toBeGreaterThanOrEqual(minimumLargestTableRows);
      const preservedRegions = observed.pages
        .flatMap((page) => page.figures)
        .filter((figure) => figure.role === "scan-region").length;
      expect(preservedRegions).toBeGreaterThanOrEqual(minimumPreservedRegions);
      expect(
        observed.pages
          .flatMap((page) => page.figures)
          .filter((figure) => figure.role === "graphic-region").length
      ).toBeGreaterThanOrEqual(minimumGraphicRegions);
      const blob = await exportDocx(model, { preservePageBreaks: true });
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xml = await zip.file("word/document.xml")!.async("string");
      expect(xml).not.toContain("w:txbxContent");
      expect(xml).not.toContain("\uFFFD");
      expect(xml).not.toContain("w:vanish");
      expect(
        (xml.match(/<w:position w:val="[1-9][\d.]*(?:pt)?"/gu) ?? []).length
      ).toBeGreaterThanOrEqual(minimumRaisedRuns);
      const parts = await Promise.all(
        Object.values(zip.files)
          .filter((entry) =>
            /^word\/(?:document|header\d+|footer\d+)\.xml$/u.test(entry.name)
          )
          .map((entry) => entry.async("string"))
      );
      // Editable fractions live in m:t; repeated page labels live in footers.
      const numbering =
        (await zip.file("word/numbering.xml")?.async("string")) ?? "";
      const text = parts
        .map((part) => docxEditableText(part, numbering))
        .join("")
        .normalize("NFKC")
        .replace(/\s/gu, "");
      if (output) {
        await mkdir(output, { recursive: true });
        await writeFile(
          resolve(output, `${id}.raw.json`),
          JSON.stringify(observed.pages, (_, value) =>
            value instanceof Uint8Array
              ? { $bytes: Buffer.from(value).toString("base64") }
              : value
          )
        );
        await writeFile(
          resolve(output, `${id}.docx`),
          new Uint8Array(await blob.arrayBuffer())
        );
        await writeFile(
          resolve(output, `${id}.model.json`),
          JSON.stringify(model, (_, value) =>
            value instanceof Uint8Array
              ? { $bytes: Buffer.from(value).toString("base64") }
              : value
          )
        );
        await writeFile(
          resolve(output, `${id}.summary.json`),
          JSON.stringify(
            {
              sha256: createHash("sha256").update(bytes).digest("hex"),
              pages: selection,
              stats: model.stats,
              preservedRegions,
              issues: model.issues,
              textChecks: expectedText.map((snippet) => ({
                expected: snippet,
                matched: text.includes(
                  snippet.normalize("NFKC").replace(/\s/gu, "")
                ),
              })),
            },
            null,
            2
          )
        );
      }
      // Preserve diagnostic artifacts even when a new corpus sample fails quality gates.
      for (const color of requiredNumberingColors) {
        expect(color).toMatch(/^[0-9A-F]{6}$/u);
        expect(numbering, `Missing native marker color ${color}`).toContain(
          `<w:color w:val="${color}"/>`
        );
      }
      const boldRuns = [...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/gu)]
        .map(([run]) => run)
        .filter((run) => /<w:b(?:\s+w:val="(?:1|true)")?\s*\/>/u.test(run))
        .map((run) =>
          [...run.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)]
            .map((m) => decodeXmlText(m[1]))
            .join("")
            .normalize("NFKC")
            .replace(/\s/gu, "")
        );
      for (const snippet of requiredBoldText)
        expect(
          boldRuns.some((text) =>
            text.includes(snippet.normalize("NFKC").replace(/\s/gu, ""))
          ),
          `Missing native bold text in ${id}: ${snippet}`
        ).toBe(true);
      const italicRuns = [...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/gu)]
        .map(([run]) => run)
        .filter((run) => /<w:i(?:\s+w:val="(?:1|true)")?\s*\/>/u.test(run))
        .map((run) =>
          [...run.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)]
            .map((m) => decodeXmlText(m[1]))
            .join("")
            .normalize("NFKC")
            .replace(/\s/gu, "")
        );
      for (const snippet of requiredItalicText)
        expect(
          italicRuns.some((text) =>
            text.includes(snippet.normalize("NFKC").replace(/\s/gu, ""))
          ),
          `Missing native italic text in ${id}: ${snippet}`
        ).toBe(true);
      expect(model.stats.characters).toBeGreaterThanOrEqual(
        minimumEditableCharacters
      );
      expect(model.stats.tables).toBeGreaterThanOrEqual(minimumTables);
      expect(model.stats.ocrPages).toBeLessThanOrEqual(maximumOcrPages);
      expect(text.length).toBeGreaterThanOrEqual(minimumEditableCharacters);
      expect((xml.match(/<w:tbl>/gu) ?? []).length).toBeGreaterThanOrEqual(
        minimumTables
      );
      // Human-transcribed source snippets are a separate accuracy gate; an
      // editable character count cannot prove that those characters are right.
      for (const snippet of expectedText)
        expect(text, `Source text mismatch in ${id}: ${snippet}`).toContain(
          snippet.normalize("NFKC").replace(/\s/gu, "")
        );
      for (const snippet of unexpectedText)
        expect(text, `Incorrect OCR text in ${id}: ${snippet}`).not.toContain(
          snippet.normalize("NFKC").replace(/\s/gu, "")
        );
    },
    900_000
  );
});
