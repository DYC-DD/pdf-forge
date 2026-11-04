import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  exportDocx,
  prepareExportPages,
} from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { detectPageSetups } from "../features/pdf2docx/lib/pageSetup";
import { findSideHeading } from "../features/pdf2docx/lib/sideHeadings";
import type { RawPage, TextSpan } from "../features/pdf2docx/types";

const make = (): TextSpan[] => {
  const span = (
    text: string,
    x: number,
    y: number,
    width: number,
    size: number
  ): TextSpan => ({
    id: text,
    text,
    x,
    y,
    width,
    height: size,
    size,
    baseline: y + size,
    font: "Helvetica",
    bold: false,
    italic: false,
    source: "pdf",
  });
  return [
    span("Form AB", 36, 30, 100, 24),
    span("Certificate", 200, 31, 100, 10),
    span("Instructions", 200, 40, 100, 10),
    span("First body line", 36, 70, 400, 10),
    span("Second body line", 36, 83, 400, 10),
  ];
};
const page = (): RawPage => ({
  number: 1,
  width: 612,
  height: 792,
  spans: make(),
  rules: [],
  figures: [],
  issues: [],
  source: "pdf",
});

describe("native side headings", () => {
  it("keeps analysis flow and shared margins stable, then exports one editable frame", async () => {
    const raw = page(),
      saved = structuredClone(raw),
      model = analyzeLayout([raw]);
    expect(raw).toEqual(saved);
    const first = model.pages[0].groups[0].columns[0][0];
    expect(first.kind).toBe("paragraph");
    if (first.kind !== "paragraph") throw new Error("heading missing");
    expect(first.sideHeading).toBe(true);
    const baseline = structuredClone(model);
    delete (baseline.pages[0].groups[0].columns[0][0] as typeof first)
      .sideHeading;
    expect(detectPageSetups(model.pages)).toEqual(
      detectPageSetups(baseline.pages)
    );
    for (const preservePageBreaks of [true, false]) {
      const prepared = prepareExportPages(model, { preservePageBreaks });
      expect(prepared[0].sideHeadings?.[0].ids).toEqual(["Form AB"]);
      const ids = prepared[0].groups
        .flatMap((g) => g.columns.flat())
        .flatMap((b) => (b.kind === "paragraph" ? b.ids : []));
      expect(ids).not.toContain("Form AB");
      expect(ids.sort()).toEqual(
        raw.spans
          .slice(1)
          .map((s) => s.id)
          .sort()
      );
      const blob = await exportDocx(model, { preservePageBreaks });
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xml = await zip.file("word/document.xml")!.async("string");
      expect((xml.match(/<w:framePr /gu) ?? []).length).toBe(1);
      expect(xml).toContain('w:x="720"');
      expect(xml).toContain('w:y="600"');
      expect(xml).toContain('w:wrap="none"');
      expect(xml).not.toContain("<w:drawing");
      expect((xml.match(/Form AB/gu) ?? []).length).toBe(1);
      expect(model.pages[0].groups[0].columns[0][0]).toEqual(first);
    }
  });
  it.each<[string, (s: TextSpan[]) => void]>([
    [
      "inconsistent font bounds",
      (s) => {
        s[0].height = 40;
      },
    ],
    [
      "an ordinary heading",
      (s) => {
        s[0].size = 14;
      },
    ],
    [
      "a wide title",
      (s) => {
        s[0].width = 200;
      },
    ],
    [
      "a single initial",
      (s) => {
        s[0].text = "A";
      },
    ],
    [
      "a preceding heading",
      (s) => {
        s.push({ ...s[3], id: "preceding", y: 0, baseline: 8 });
      },
    ],
    [
      "only one neighboring line",
      (s) => {
        s.splice(2, 1);
      },
    ],
    [
      "overlapping text",
      (s) => {
        s.push({ ...s[1], id: "overlap", x: 45, y: 35, baseline: 43 });
      },
    ],
    [
      "OCR",
      (s) => {
        s[0].source = "ocr";
      },
    ],
    [
      "rotation",
      (s) => {
        s[0].rotation = 90;
      },
    ],
    [
      "oblique text",
      (s) => {
        s[0].oblique = { angle: 15, baselineX: 36 };
      },
    ],
    [
      "RTL",
      (s) => {
        s[0].text = "עברית";
      },
    ],
    [
      "mathematics",
      (s) => {
        s[0].text = "A=B";
      },
    ],
  ])("does not promote %s", (_, change) => {
    const spans = make();
    change(spans);
    expect(findSideHeading(spans, 10, 612)).toBeUndefined();
  });
});
