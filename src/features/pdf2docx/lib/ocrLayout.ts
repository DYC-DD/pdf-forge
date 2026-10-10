import type { Block } from "tesseract.js";

import type { Rule } from "../types";

export function horizontalTextPage(
  blocks: readonly Block[],
  width: number,
  rules: readonly Rule[]
): boolean {
  const horizontal = rules.filter((r) => Math.abs(r.y2 - r.y1) < 2);
  const vertical = rules.filter((r) => Math.abs(r.x2 - r.x1) < 2);
  if (horizontal.length >= 2 && vertical.length >= 2) return false;
  const lines = blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const rows: { x0: number; y0: number; x1: number; y1: number }[][] = [];
  for (const box of lines
    .map((line) => line.bbox)
    .sort((a, b) => a.y0 - b.y0)) {
    const row = rows.at(-1),
      reference = row?.[0];
    const overlap = reference
      ? Math.min(reference.y1, box.y1) - Math.max(reference.y0, box.y0)
      : 0;
    if (
      row &&
      reference &&
      overlap >= Math.max(reference.y1 - reference.y0, box.y1 - box.y0) * 0.7
    )
      row.push(box);
    else rows.push([box]);
  }
  // AUTO sometimes splits ordinary prose at a punctuation mark into two OCR
  // lines on the same baseline. Join only sub-character gaps for classification;
  // an actual column gutter must not become evidence for page-wide prose.
  const boxes = rows.flatMap((row) => {
    const joined: (typeof row)[number][] = [];
    for (const box of row.sort((a, b) => a.x0 - b.x0)) {
      const previous = joined.at(-1);
      if (
        previous &&
        box.x0 - previous.x1 <=
          Math.min(previous.y1 - previous.y0, box.y1 - box.y0) * 0.8
      )
        joined[joined.length - 1] = {
          x0: previous.x0,
          y0: Math.min(previous.y0, box.y0),
          x1: Math.max(previous.x1, box.x1),
          y1: Math.max(previous.y1, box.y1),
        };
      else joined.push(box);
    }
    return joined;
  });
  // Only dense, predominantly page-wide prose supplies evidence for a single
  // horizontal writing area. Covers, forms, grids and narrow columns keep AUTO.
  const wide = boxes.filter(
    (box) =>
      box.x1 - box.x0 >= width * 0.5 &&
      box.y1 - box.y0 < (box.x1 - box.x0) * 0.1
  );
  return (
    rows.length >= 24 &&
    wide.length >= Math.max(6, boxes.length * 0.3) &&
    Math.max(...wide.map((box) => box.x0)) -
      Math.min(...wide.map((box) => box.x0)) <=
      width * 0.25
  );
}

type OcrText = { text: string; confidence: number };
export function preferHorizontalText(primary: OcrText, candidate: OcrText) {
  const first = primary.text.replace(/\s/gu, ""),
    second = candidate.text.replace(/\s/gu, "");
  if (
    candidate.confidence < primary.confidence ||
    second.length < first.length * 0.95 ||
    second.length > first.length * 1.2
  )
    return false;
  // Confidence alone can reward lost content. Require substantial agreement
  // with the first pass before accepting a different page segmentation.
  const pairs = (text: string) => {
    const chars = Array.from(text),
      counts = new Map<string, number>();
    for (let i = 1; i < chars.length; i++) {
      const pair = chars[i - 1] + chars[i];
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  };
  const a = pairs(first),
    b = pairs(second);
  let shared = 0;
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0);
  return (2 * shared) / Math.max(1, first.length + second.length - 2) >= 0.85;
}
