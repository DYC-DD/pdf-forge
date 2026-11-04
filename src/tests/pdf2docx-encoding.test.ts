import { describe, expect, it } from "vitest";

import { encodingRegions } from "../features/pdf2docx/lib/encodingRegions";
import type { RawPage, TableModel, TextSpan } from "../features/pdf2docx/types";

const span = (text: string, x: number, y: number, width = 80): TextSpan => ({
  id: `${x}:${y}`,
  text,
  x,
  y,
  width,
  height: 12,
  baseline: y + 10,
  size: 12,
  font: "Arial",
  bold: false,
  italic: false,
  source: "pdf",
});
function fixture() {
  const raw: RawPage = {
    number: 1,
    width: 600,
    height: 800,
    source: "pdf",
    figures: [],
    rules: [],
    issues: [
      {
        page: 1,
        code: "encoding",
        message: "Unreadable mapping",
        severity: "error",
      },
    ],
    spans: [
      span("Uncertain \uFFFD text", 55, 55),
      span("Caption", 55, 72),
      ...Array.from({ length: 4 }, (_, i) =>
        span("Native neighboring text remains editable.", 160, 55 + i * 18, 220)
      ),
    ],
  };
  const table: TableModel = {
    kind: "table",
    x: 50,
    y: 50,
    width: 300,
    height: 40,
    before: 0,
    columns: [100, 200],
    rows: [40],
    cells: [0, 1].map((column) => ({
      row: 0,
      column,
      rowSpan: 1,
      columnSpan: 1,
      paragraphs: [],
    })),
  };
  return { raw, table };
}
describe("local uncertain character-map regions", () => {
  it("retains a complete bounded cell while leaving neighboring prose editable", () => {
    const { raw, table } = fixture();
    raw.spans.push(span(" ", 40, 60, 400));
    expect(encodingRegions(raw, [table])).toEqual([
      { x: 50, y: 50, width: 100, height: 40 },
    ]);
    expect(raw.spans.filter((s) => s.rasterized).map((s) => s.text)).toEqual([
      "Uncertain \uFFFD text",
      "Caption",
    ]);
    expect(raw.spans.slice(2).every((s) => !s.rasterized)).toBe(true);
    expect(raw.issues.map((i) => [i.code, i.severity])).toEqual([
      ["encoding-region", "review"],
    ]);
  });
  it.each(["outside", "crossing", "large", "sparse", "many"])(
    "keeps the error and leaves text untouched for %s cases",
    (mode) => {
      const { raw, table } = fixture();
      if (mode === "outside") raw.spans.push(span("Unmapped \uFFFD", 400, 400));
      if (mode === "crossing")
        raw.spans.push(span("Border-crossing text", 130, 60, 80));
      if (mode === "large") {
        table.columns = [300, 0];
        table.rows = [120];
      }
      if (mode === "sparse") raw.spans = raw.spans.slice(0, 2);
      const tables =
        mode === "many" ? Array.from({ length: 9 }, () => table) : [table];
      const before = structuredClone(raw);
      expect(encodingRegions(raw, tables)).toEqual([]);
      expect(raw).toEqual(before);
    }
  );
  it("does not interpret normal multilingual text as an encoding error", () => {
    const { raw, table } = fixture();
    raw.spans[0].text = "العربية עברית हिन्दी";
    const before = structuredClone(raw);
    expect(encodingRegions(raw, [table])).toEqual([]);
    expect(raw).toEqual(before);
  });
});
