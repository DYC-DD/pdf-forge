import { describe, expect, it } from "vitest";

import { textBackgrounds } from "../features/pdf2docx/lib/textBackgrounds";
import type { RawPage, TableModel } from "../features/pdf2docx/types";

function fixture() {
  const raw: RawPage = {
    number: 1,
    width: 600,
    height: 800,
    source: "pdf",
    figures: [],
    rules: [],
    issues: [],
    fills: [
      {
        x: 36,
        y: 100,
        width: 36,
        height: 12,
        color: "000000",
        paintOrder: 10,
        opaque: true,
      },
    ],
    spans: [
      {
        id: "label",
        text: "Part I",
        x: 41,
        y: 99.4,
        width: 26,
        height: 10,
        baseline: 109,
        size: 10,
        font: "Helvetica",
        bold: true,
        italic: false,
        source: "pdf",
        color: "FFFFFF",
        paintOrder: 11,
      },
    ],
  };
  const vectors = [{ box: raw.fills![0], index: 10, artwork: false }];
  return { raw, vectors };
}
describe("editable text label backgrounds", () => {
  it("associates a small opaque rectangle with its white source text", () => {
    const { raw, vectors } = fixture();
    expect(textBackgrounds(raw, vectors, [])).toEqual([
      expect.objectContaining({
        ids: ["label"],
        index: 10,
        width: 36,
        height: 12,
      }),
    ]);
    expect(raw.spans[0].rasterized).toBeUndefined();
  });
  it("rejects light, transparent, oversized and nonrectangular artwork", () => {
    for (const patch of [
      { color: "EEEEEE" },
      { opaque: false },
      { width: 200 },
      { height: 50 },
    ]) {
      const { raw, vectors } = fixture();
      Object.assign(raw.fills![0], patch);
      expect(textBackgrounds(raw, vectors, [])).toEqual([]);
    }
    const { raw, vectors } = fixture();
    vectors[0].artwork = true;
    expect(textBackgrounds(raw, vectors, [])).toEqual([]);
  });
  it("rejects unsupported text, paint order, crossing text and multiple baselines", () => {
    for (const patch of [
      { source: "ocr" },
      { rotation: 90 },
      { color: "000000" },
      { paintOrder: 9 },
      { paintOrder: undefined },
      { width: 50 },
      { text: "X".repeat(41) },
    ]) {
      const { raw, vectors } = fixture();
      Object.assign(raw.spans[0], patch);
      expect(textBackgrounds(raw, vectors, [])).toEqual([]);
    }
    const { raw, vectors } = fixture();
    raw.spans.push({ ...raw.spans[0], id: "second", baseline: 112 });
    expect(textBackgrounds(raw, vectors, [])).toEqual([]);
  });
  it("retains ordinary handling for table fills and later overpaint", () => {
    const { raw, vectors } = fixture();
    const table: TableModel = {
      kind: "table",
      x: 30,
      y: 95,
      width: 100,
      height: 30,
      before: 0,
      columns: [100],
      rows: [30],
      cells: [],
    };
    expect(textBackgrounds(raw, vectors, [table])).toEqual([]);
    raw.fills!.push({ ...raw.fills![0], paintOrder: 12, color: "FFFFFF" });
    expect(textBackgrounds(raw, vectors, [])).toEqual([]);
  });
  it("does not infer a background from absent, hidden or rasterized lettering", () => {
    for (const spans of [[], [{ hidden: true }], [{ rasterized: true }]]) {
      const { raw, vectors } = fixture();
      raw.spans = spans.map((patch) => ({ ...raw.spans[0], ...patch }));
      expect(textBackgrounds(raw, vectors, [])).toEqual([]);
    }
  });
});
