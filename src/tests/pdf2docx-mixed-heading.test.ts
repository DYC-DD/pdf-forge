import JSZip from "jszip";
import { expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import type { TextSpan } from "../features/pdf2docx/types";

it.each([
  "larger-right",
  "smaller-right",
  "body",
  "different-font",
  "size-disparity",
  "rtl-leading",
  "phrase",
  "baseline-shift",
  "multiple-lines",
  "reflow",
])("preserves mixed heading sizes and bounds for %s", async (kind) => {
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
    baseline: y + size,
    size,
    font: "NotoSerif-Regular",
    bold: false,
    italic: false,
    source: "pdf",
  });
  const model = analyzeLayout([
    {
      number: 1,
      width: 300,
      height: 300,
      source: "pdf",
      figures: [],
      rules: [],
      issues: [],
      spans: [
        span("Input", 20, 54, 41.808, 16),
        span("Output", 180, 50, 66.6, 20),
        span("Body establishes width", 20, 110, 226.6, 12),
      ],
    },
  ]);
  const p = model.pages[0].groups
    .flatMap((g) => g.columns.flat())
    .find((p) => p.kind === "paragraph" && p.runs[0].text === "Input");
  if (!p || p.kind !== "paragraph") throw new Error("Missing heading");
  expect(p.runs).toHaveLength(2);
  expect(p.role).toBe("heading");
  if (kind === "smaller-right") {
    p.runs[0].size = 20;
    p.runs[1].size = 16;
  }
  if (kind === "body") p.role = "body";
  if (kind === "different-font") p.runs[0].font = "Helvetica";
  if (kind === "size-disparity") p.runs[0].size = 10;
  if (kind === "rtl-leading") p.runs[0].text = "אבגד";
  if (kind === "phrase") p.runs[0].text = "Input heading";
  if (kind === "baseline-shift") p.runs[0].baselineShift = 3;
  if (kind === "multiple-lines") p.lineCount = 2;
  const before = structuredClone(model);
  const zip = await JSZip.loadAsync(
    await (
      await exportDocx(model, { preservePageBreaks: kind !== "reflow" })
    ).arrayBuffer()
  );
  const xml = await zip.file("word/document.xml")!.async("string");
  const para = [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gu)]
    .map((m) => m[0])
    .find((x) => x.includes("Output"))!;
  const positive = ["larger-right", "smaller-right"].includes(kind);
  expect(para.includes('<w:tab w:val="right"')).toBe(positive);
  for (const run of p.runs) {
    const r = [...para.matchAll(/<w:r>.*?<\/w:r>/gu)]
      .map((m) => m[0])
      .find((x) => x.includes(`>${run.text}</w:t>`))!;
    expect(r).toContain(`<w:sz w:val="${run.size * 2}"`);
    if (positive)
      expect(r).toContain(`<w:fitText w:val="${Math.round(run.width! * 20)}"`);
  }
  if (positive) {
    const tab = Number(/<w:tab w:val="right" w:pos="(\d+)"/u.exec(para)![1]);
    const margin = Number(/<w:pgMar[^>]*w:left="(\d+)"/u.exec(xml)![1]);
    expect(tab + margin).toBe(246.6 * 20);
  }
  expect(xml).not.toContain("<w:drawing");
  expect(model).toEqual(before);
});
