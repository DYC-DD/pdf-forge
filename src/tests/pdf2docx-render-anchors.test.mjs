import { expect, it } from "vitest";

import { textAnchors } from "../../scripts/pdf2docx-text-anchors.mjs";

const item = (text, x, y = 100) => ({
  text,
  x,
  y,
  width: text.length * 6,
  height: 10,
  dir: "ltr",
});
it("locates fragmented fitted Latin labels at their actual first glyph", () => {
  const pieces = [..."Source Address"].map((c, i) => item(c, 254 + i * 6));
  expect(textAnchors(pieces, "Source Address")).toEqual([{ x: 254, y: 100 }]);
  const displaced = pieces.map((p) => ({ ...p, x: p.x - 96 }));
  expect(textAnchors(displaced, "Source Address")).toEqual([
    { x: 158, y: 100 },
  ]);
});
it("does not join across rows, columns, reversed order, or missing letters", () => {
  expect(
    textAnchors(
      [item("Source", 10), item("Address", 10, 112)],
      "Source Address"
    )
  ).toEqual([]);
  expect(
    textAnchors([item("Source", 10), item("Address", 300)], "Source Address")
  ).toEqual([]);
  expect(
    textAnchors([item("Source", 100), item("Address", 10)], "Source Address")
  ).toEqual([]);
  expect(
    textAnchors([item("Sourc", 10), item("Address", 46)], "Source Address")
  ).toEqual([]);
});
it("retains direct-run anchors and repeated fragmented occurrences", () => {
  expect(textAnchors([item("Source Address", 254)], "Source Address")).toEqual([
    { x: 254, y: 100 },
  ]);
  expect(
    textAnchors(
      [
        item("Source", 10),
        item("Address", 52),
        item("Source", 10, 120),
        item("Address", 52, 120),
      ],
      "Source Address"
    )
  ).toEqual([
    { x: 10, y: 100 },
    { x: 10, y: 120 },
  ]);
  expect(textAnchors([item("עב", 10), item("רית", 22)], "עברית")).toEqual([]);
});
