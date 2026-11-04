import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { findDropCaps } from "../features/pdf2docx/lib/dropCaps";
import {
  exportDocx,
  prepareExportPages,
} from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { applyPageSetup } from "../features/pdf2docx/lib/pageSetup";
import type { RawPage, TextSpan } from "../features/pdf2docx/types";

const make = (): TextSpan[] => {
  const span = (
    text: string,
    x: number,
    y: number,
    size: number,
    baseline: number,
    width: number
  ): TextSpan => ({
    id: text,
    text,
    x,
    y,
    size,
    baseline,
    width,
    height: size,
    font: "Times-Roman",
    bold: false,
    italic: false,
    source: "pdf",
  });
  return [
    span("O", 100, 25, 72, 102, 53),
    span("ur first body line", 153, 44, 16, 62, 297),
    span("second body line", 153, 64, 16, 82, 297),
    span("third body line", 153, 84, 16, 102, 297),
    span("Body returns to the left edge", 100, 104, 16, 122, 350),
    span("Last body line", 100, 124, 16, 142, 350),
  ];
};
const page = (spans = make()): RawPage => ({
  number: 1,
  width: 612,
  height: 792,
  spans,
  rules: [],
  figures: [],
  issues: [],
  source: "pdf",
});

describe("native drop caps", () => {
  it("separates the initial from the third baseline without losing source text", () => {
    const raw = page(),
      before = structuredClone(raw),
      model = analyzeLayout([raw]);
    expect(raw).toEqual(before);
    expect(model.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(model.stats.images).toBe(0);
    expect(model.pages[0].dropCaps?.[0].runs.map((r) => r.text)).toEqual(["O"]);
    const body = model.pages[0].groups
      .flatMap((g) => g.columns.flat())
      .filter((b) => b.kind === "paragraph");
    expect(body[0].runs[0].text).toBe("ur first body line");
    expect(body[0].lineCount).toBe(3);
    expect(body[0].lineHeight).toBe(20);
    expect(body[1].y).toBe(104);
    expect(body.flatMap((b) => b.ids).sort()).toEqual(
      raw.spans
        .slice(1)
        .map((s) => s.id)
        .sort()
    );
  });
  it.each([
    [
      "a whole word",
      (s: TextSpan[]) => {
        s[0].text = "OPEN";
      },
    ],
    [
      "a rotated initial",
      (s: TextSpan[]) => {
        s[0].rotation = 90;
      },
    ],
    [
      "an OCR initial",
      (s: TextSpan[]) => {
        s[0].source = "ocr";
      },
    ],
    [
      "text preceded by a title",
      (s: TextSpan[]) => {
        s.push({ ...s[1], id: "title", text: "Title", y: 0, baseline: 18 });
      },
    ],
    [
      "a heading-like continuation",
      (s: TextSpan[]) => {
        s[1].text = "Title starts here";
      },
    ],
    [
      "nonuniform leading",
      (s: TextSpan[]) => {
        s[2].baseline += 5;
      },
    ],
    [
      "no return to the left edge",
      (s: TextSpan[]) => {
        s[4].x = 153;
      },
    ],
    [
      "a Greek mathematical capital",
      (s: TextSpan[]) => {
        s[0].text = "Σ";
      },
    ],
    [
      "a formula continuation",
      (s: TextSpan[]) => {
        s[1].text = "x + y = z";
      },
    ],
  ] as const)("leaves %s in ordinary flow", (_, change) => {
    const spans = make();
    change(spans);
    expect(findDropCaps(spans, 16)).toEqual([]);
  });
  it("maps frame geometry with page size while keeping the original text size", () => {
    const original = analyzeLayout([page()]).pages[0];
    const mapped = applyPageSetup(original, {
      paperSize: "source",
      width: 1224,
      height: 1584,
      marginPreset: "detected",
      margins: { left: 200, right: 324, top: 50, bottom: 200 },
    });
    expect(mapped.dropCaps?.[0]).toMatchObject({ x: 200, y: 50, width: 106 });
    expect(mapped.dropCaps?.[0].runs[0].size).toBe(72);
    expect(original.dropCaps?.[0].x).toBe(100);
  });
  it("exports a single editable frame and a minimal anchor before source-spaced body text", async () => {
    const model = analyzeLayout([page()]);
    const before = structuredClone(model);
    const blob = await exportDocx(model, { preservePageBreaks: true });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    expect((xml.match(/<w:framePr /gu) ?? []).length).toBe(1);
    expect(xml).toContain('w:x="2000"');
    expect(xml).toContain('w:y="500"');
    expect(xml).toContain('w:wrap="none"');
    expect(xml).toContain('w:sz w:val="144"');
    expect(xml).toContain('w:line="1"');
    expect(xml).not.toContain("<w:drawing");
    expect(xml.indexOf(">O</w:t>")).toBeLessThan(
      xml.indexOf("ur first body line")
    );
    expect(model).toEqual(before);
  });
});

it("keeps page-relative initial frames on their source pages in reflow export", async () => {
  const first = page(),
    second = page();
  second.number = 2;
  const model = analyzeLayout([first, second]);
  expect(prepareExportPages(model, { preservePageBreaks: false })).toEqual(
    model.pages
  );
  const blob = await exportDocx(model, { preservePageBreaks: false });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file("word/document.xml")!.async("string");
  expect((xml.match(/<w:framePr /gu) ?? []).length).toBe(2);
  expect(
    (xml.match(/w:type w:val="nextPage"/gu) ?? []).length
  ).toBeGreaterThanOrEqual(2);
});
