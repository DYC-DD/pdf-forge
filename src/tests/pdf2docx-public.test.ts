import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzePdf } from "../features/pdf2docx/lib/analyzePdf";
import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { extractPage } from "../features/pdf2docx/lib/extractPage";
import { paragraphText } from "../features/pdf2docx/lib/paragraphs";
import { openPdf } from "../shared/pdf/preview";
import samples from "./__fixtures__/pdf2docx-public.json";

vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL(
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url
  ).href,
}));

const directory = process.env.PDF2DOCX_PUBLIC_DIR;
const output = process.env.PDF2DOCX_QA_DIR;

beforeEach(() => {
  vi.stubEnv(
    "BASE_URL",
    fileURLToPath(new URL("../../public/", import.meta.url)).replaceAll(
      "\\",
      "/"
    )
  );
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

describe.skipIf(!directory)(
  "public PDF conversion corpus (opt in, no network in tests)",
  () => {
    it.each(samples)(
      "converts $id",
      async ({ id, pages, sha256 }) => {
        const bytes = await readFile(resolve(directory!, `${id}.pdf`));
        expect(
          createHash("sha256").update(bytes).digest("hex"),
          "upstream fixture changed"
        ).toBe(sha256);
        const model = await analyzePdf(new File([bytes], `${id}.pdf`), pages, {
          ocr: "off",
          language: "eng",
        });
        const blob = await exportDocx(model, { preservePageBreaks: true });
        const zip = await JSZip.loadAsync(await blob.arrayBuffer());
        const xml = await zip.file("word/document.xml")!.async("string");
        expect(xml).not.toContain("w:txbxContent");
        expect(
          model.issues.filter((issue) => issue.severity === "error")
        ).toEqual([]);
        expect(model.pages.map((page) => page.number)).toEqual(pages);
        for (const paragraph of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g))
          expect(
            (paragraph[0].match(/<w:tab w:val=/g) ?? []).length
          ).toBeLessThanOrEqual(64);
        const blocks = model.pages.flatMap((page) =>
          page.groups.flatMap((group) => group.columns.flat())
        );
        const tables = blocks.filter((block) => block.kind === "table");
        if (id === "w3c-lists") {
          const paragraphs = blocks.filter(
            (block) => block.kind === "paragraph"
          );
          expect(
            paragraphs.filter((p) => p.role === "list").map(paragraphText)
          ).toEqual([
            "• Rocky High School",
            "• Moose Middle School",
            "• Peabody Elementary",
            "1. Snow-shoeing",
            "2. Ice-skating",
            "3. Skiing",
          ]);
          expect(
            paragraphs.filter((p) => p.role === "body").map(paragraphText)
          ).toContain("The most popular school sports are:");
        } else if (id === "w3c-columns-oo") {
          expect(model.pages[0].groups).toHaveLength(1);
          const columns = model.pages[0].groups[0].columns;
          expect(columns).toHaveLength(2);
          const text = columns.map((column) =>
            column
              .filter((block) => block.kind === "paragraph")
              .map(paragraphText)
              .join("\n")
          );
          expect(text[0]).toMatch(/^Application for this and\s+that/);
          expect(text[0]).toContain("Header One");
          expect(text[0]).not.toContain("Another");
          expect(text[1]).toMatch(/^tincidunt consectetur ut vitae ligula\./);
          expect(text[1]).toContain("Another Header One");
          expect(text[1]).not.toContain("Nullam a est");
        } else if (id === "w3c-page-numbers") {
          expect(
            model.pages[4].footer?.runs.find((run) => run.pageNumber)?.text
          ).toBe("1");
          expect(xml).toContain('<w:pgNumType w:start="1"');
          for (const label of ["i", "ii", "iii", "iv"])
            expect(xml).toContain(`>${label}</w:t>`);
        } else if (id === "w3c-table") {
          expect(tables).toHaveLength(1);
          expect(tables[0].columns).toHaveLength(5);
          expect(tables[0].rows).toHaveLength(5);
          expect(
            tables[0].cells
              .filter((cell) => cell.row > 0)
              .map((cell) => cell.paragraphs.map(paragraphText).join(""))
          ).toEqual([
            "Elm Street",
            "23",
            "24",
            "26",
            "22",
            "Spruce Street",
            "25",
            "30",
            "26",
            "23",
            "Locust Street",
            "24",
            "28",
            "22",
            "27",
            "Maple Street",
            "26",
            "26",
            "21",
            "29",
          ]);
        } else if (id === "w3c-columns") {
          const columns = model.pages[0].groups.find(
            (group) => group.columns.length === 2
          )!.columns;
          const text = columns.map((column) =>
            column
              .filter((block) => block.kind === "paragraph")
              .map(paragraphText)
              .join("\n")
          );
          expect(text[0]).toContain("Application for this and that");
          expect(text[0]).toContain("1. Aenean");
          expect(text[0]).not.toContain("2. Nulla");
          expect(text[1]).toMatch(/^2\. Nulla/);
          expect(text[1]).toContain("Another Header One");
        } else if (id === "tracemonkey") {
          const diagram = model.pages[1].groups
            .flatMap((group) => group.columns.flat())
            .find(
              (block) =>
                block.kind === "image" && block.role === "graphic-region"
            );
          expect(diagram).toBeDefined();
          expect(diagram!.width).toBeGreaterThan(150);
          expect(diagram!.height).toBeGreaterThan(150);
          const pageText = model.pages[1].groups
            .flatMap((group) => group.columns.flat())
            .filter((block) => block.kind === "paragraph")
            .map(paragraphText)
            .join(" ");
          expect(pageText).toContain("Figure 2.");
          expect(pageText).toContain("Here is the sequence of events");
          expect(pageText).not.toContain("Symbol Key");
          expect(
            model.pages.every((page) =>
              page.groups.some((group) => group.columns.length === 2)
            )
          ).toBe(true);
          const first = model.pages[0].groups
            .flatMap((group) => group.columns.flat())
            .filter((block) => block.kind === "paragraph");
          expect(
            first.some((paragraph) =>
              paragraph.runs.some((run) => (run.baselineShift ?? 0) > 0)
            )
          ).toBe(true);
          const table = tables.find((table) => table.columns.length === 10)!;
          expect(table?.rows).toHaveLength(27);
          expect(
            table.cells
              .filter((cell) => cell.row === 1)
              .map((cell) => cell.paragraphs.map(paragraphText).join(""))
          ).toEqual([
            "3d-cube",
            "25",
            "27",
            "29",
            "3",
            "0",
            "1.1",
            "1.1",
            "1.2",
            "2.20x",
          ]);
          expect(
            table.cells
              .filter((cell) => cell.row === 26)
              .map((cell) => cell.paragraphs.map(paragraphText).join(""))
          ).toEqual([
            "string-validate-input",
            "6",
            "10",
            "13",
            "1",
            "0",
            "1.7",
            "1.3",
            "2.2",
            "1.86x",
          ]);
        } else if (id === "tw-urban") {
          expect(tables).toHaveLength(3);
          expect(
            model.pages.every((page) =>
              page.groups.every((group) => group.columns.length === 1)
            )
          ).toBe(true);
          expect(
            model.pages
              .filter((page) => page.height > 1100)
              .map((page) => page.number)
          ).toEqual([6, 7]);
          for (const page of model.pages) {
            expect(
              page.footer?.runs
                .filter((run) => run.pageNumber)
                .map((run) => run.text)
            ).toEqual([String(page.number)]);
            expect(paragraphText(page.footer!).replace(/\s/gu, "")).toContain(
              "共99頁"
            );
          }
        }
        if (output) {
          await mkdir(output, { recursive: true });
          const task = await openPdf(new File([bytes], `${id}.pdf`));
          try {
            const pdf = await task.promise;
            const raw = [];
            for (const page of pages)
              raw.push((await extractPage(await pdf.getPage(page))).raw);
            await writeFile(
              resolve(output, `${id}.raw.json`),
              JSON.stringify(raw)
            );
          } finally {
            await task.destroy();
          }
          await writeFile(
            resolve(output, `${id}.docx`),
            new Uint8Array(await blob.arrayBuffer())
          );
          await writeFile(
            resolve(output, `${id}.json`),
            JSON.stringify(
              model,
              (_, value) =>
                value instanceof Uint8Array ? `[${value.length} bytes]` : value,
              2
            )
          );
          await writeFile(
            resolve(output, `${id}.txt`),
            model.pages
              .map(
                (page) =>
                  `PAGE ${page.number}\n` +
                  page.groups
                    .flatMap((group) => group.columns.flat())
                    .flatMap((block) =>
                      block.kind === "paragraph"
                        ? [paragraphText(block)]
                        : block.kind === "table"
                          ? block.cells.flatMap((cell) =>
                              cell.paragraphs.map(paragraphText)
                            )
                          : []
                    )
                    .join("\n")
              )
              .join("\n\n")
          );
        }
      },
      120_000
    );
  }
);
