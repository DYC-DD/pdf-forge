import { describe, expect, it } from "vitest";

import { diagramGraphics } from "../features/pdf2docx/lib/diagramGraphics";
import type { Box, RawPage, TextSpan } from "../features/pdf2docx/types";

const artwork: Box[] = [
  { x: 300, y: 100, width: 65, height: 80 },
  { x: 360, y: 100, width: 65, height: 80 },
  { x: 420, y: 100, width: 65, height: 80 },
];
const span = (
  text: string,
  x: number,
  y: number,
  width: number,
  size: number
): TextSpan => ({
  id: `${x}:${y}`,
  text,
  x,
  y,
  width,
  height: size,
  baseline: y + size,
  size,
  source: "pdf",
  font: "Helvetica",
  bold: false,
  italic: false,
});
function page(): RawPage {
  return {
    number: 1,
    width: 600,
    height: 800,
    source: "pdf",
    rules: [],
    figures: [],
    issues: [],
    spans: [
      ...Array.from({ length: 20 }, (_, i) =>
        span("Editable body prose", 50, 50 + i * 16, 220, 12)
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        span(
          `Label ${i}`,
          308 + (i % 3) * 60,
          110 + Math.floor(i / 3) * 20,
          45,
          7
        )
      ),
    ],
  };
}
describe("unframed diagrams", () => {
  it("keeps a connected diagram together without claiming adjacent body text", () => {
    expect(diagramGraphics(page(), artwork, [])).toEqual([
      { x: 300, y: 100, width: 185, height: 80 },
    ]);
  });
  it("does not crop a sentence that crosses the artwork boundary", () => {
    const raw = page();
    raw.spans.push(
      span("A sentence crossing into the diagram", 270, 130, 250, 12)
    );
    expect(diagramGraphics(raw, artwork, [])).toEqual([]);
  });
  it("requires multiple small labels and does not flatten body-sized text", () => {
    const raw = page();
    raw.spans.forEach((s) => {
      s.size = 12;
    });
    expect(diagramGraphics(raw, artwork, [])).toEqual([]);
    expect(diagramGraphics(page(), [artwork[0]], [])).toEqual([]);
  });
  it("does not duplicate a graphic already preserved by its frame", () => {
    expect(
      diagramGraphics(
        page(),
        artwork,
        [],
        [{ x: 300, y: 100, width: 185, height: 80 }]
      )
    ).toEqual([]);
  });
  it("bounds the search on excessively dense artwork", () => {
    expect(diagramGraphics(page(), Array(2001).fill(artwork[0]), [])).toEqual(
      []
    );
  });
});
