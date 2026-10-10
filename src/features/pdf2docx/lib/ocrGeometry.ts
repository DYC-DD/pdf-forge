import type { Block, Line } from "tesseract.js";

import type { TextSpan } from "../types";
import { median } from "./geometry";
import { DOCX_LIMITS } from "./limits";

// Tesseract sometimes groups the left-hand markers of several horizontal
// clauses into a vertical line. Its height is not a font size or a baseline.
function horizontalLines(line: Line): Line[] {
  const box = line.bbox;
  if (
    box.y1 - box.y0 < (box.x1 - box.x0) * 1.6 ||
    Math.abs(line.baseline.y1 - line.baseline.y0) <
      Math.abs(line.baseline.x1 - line.baseline.x0)
  )
    return [line];
  return line.words.map((word) => ({
    ...line,
    bbox: word.bbox,
    words: [word],
    baseline: {
      x0: word.bbox.x0,
      x1: word.bbox.x1,
      y0: word.bbox.y1,
      y1: word.bbox.y1,
    },
  }));
}

export function ocrSpans(
  blocks: readonly Block[],
  scale: number,
  page: number
): TextSpan[] {
  const lines = blocks.flatMap((block, bi) =>
    block.paragraphs.flatMap((paragraph, pi) =>
      paragraph.lines.flatMap((line, li) =>
        horizontalLines(line).map((entry, part) => ({
          line: entry,
          fragment: entry !== line,
          blockId: `${page}:ocr-block:${bi}`,
          paragraphId: `${page}:ocr-block:${bi}:paragraph:${pi}`,
          lineId: `${page}:${bi}:${pi}:${li}:${part}`,
        }))
      )
    )
  );
  const spans: TextSpan[] = [];
  for (const entry of lines) {
    let { line, blockId, paragraphId, lineId } = entry;
    if (entry.fragment) {
      const center = (line.bbox.y0 + line.bbox.y1) / 2;
      const neighbor = lines
        .filter(
          (other) =>
            !other.fragment && other.line.bbox.x1 - other.line.bbox.x0 > 40
        )
        .map((other) => ({
          other,
          delta: Math.abs(
            (other.line.bbox.y0 + other.line.bbox.y1) / 2 - center
          ),
        }))
        .filter(
          ({ other, delta }) =>
            delta < (other.line.bbox.y1 - other.line.bbox.y0) * 0.75
        )
        .sort((a, b) => a.delta - b.delta)[0]?.other;
      if (neighbor) {
        line = {
          ...line,
          bbox: {
            ...line.bbox,
            y0: neighbor.line.bbox.y0,
            y1: neighbor.line.bbox.y1,
          },
          baseline: neighbor.line.baseline,
        };
        ({ blockId, paragraphId, lineId } = neighbor);
      }
    }
    const height = (line.bbox.y1 - line.bbox.y0) / scale;
    const hasCjk = /\p{Script=Han}/u.test(
      line.words.map((word) => word.text).join("")
    );
    // Reject swollen word boxes (common with the CJK model) and punctuation
    // when estimating type. A single unusual glyph must not resize a whole row.
    const heights = line.words
      .filter((word) => /[\p{L}\p{N}]/u.test(word.text))
      .map((word) => (word.bbox.y1 - word.bbox.y0) / scale)
      .filter((value) => value >= 2 && value <= height * 1.25);
    const cluster =
      heights
        .map((value) =>
          heights.filter(
            (other) => Math.abs(other - value) < Math.max(0.75, value * 0.18)
          )
        )
        .sort((a, b) => b.length - a.length)[0] ?? [];
    const inkHeight = cluster.length ? median(cluster) : height;
    let size = Math.max(4, Math.min(height, inkHeight) / (hasCjk ? 0.9 : 0.72));
    // Chinese glyph boxes measure ink, not the em square. Several adjacent
    // single-character words provide a stronger estimate of full-width type
    // advance; this avoids inflating scanned text until every line rewraps.
    const ordered = [...line.words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const pitches = ordered.slice(1).flatMap((word, index) => {
      const previous = ordered[index];
      if (
        !/^\p{Script=Han}$/u.test(word.text) ||
        !/^\p{Script=Han}$/u.test(previous.text)
      )
        return [];
      const pitch =
        (word.bbox.x0 + word.bbox.x1 - previous.bbox.x0 - previous.bbox.x1) /
        2 /
        scale;
      return pitch >= size * 0.65 && pitch <= size * 1.35 ? [pitch] : [];
    });
    if (pitches.length >= 6) {
      const pitch = median(pitches);
      if (
        pitches.filter((value) => Math.abs(value - pitch) <= pitch * 0.15)
          .length >=
        pitches.length * 0.75
      )
        size = Math.max(4, Math.min(size, pitch));
    }
    for (const word of line.words) {
      if (!word.text) continue;
      if (spans.length >= DOCX_LIMITS.spansPerPage)
        throw new Error(`第 ${page} 頁辨識文字超過目前上限，請減少頁面內容。`);
      const { x0, x1 } = word.bbox;
      const y0 = Math.max(word.bbox.y0, line.bbox.y0);
      const y1 = Math.max(y0 + 1, Math.min(word.bbox.y1, line.bbox.y1));
      const dx = line.baseline.x1 - line.baseline.x0;
      const ratio = dx
        ? Math.max(0, Math.min(1, ((x0 + x1) / 2 - line.baseline.x0) / dx))
        : 0;
      spans.push({
        id: `${page}:ocr:${spans.length}`,
        text: word.text,
        x: x0 / scale,
        y: y0 / scale,
        width: (x1 - x0) / scale,
        height: (y1 - y0) / scale,
        baseline:
          (line.baseline.y0 + ratio * (line.baseline.y1 - line.baseline.y0)) /
          scale,
        size,
        font: "Noto Sans CJK TC",
        bold: false,
        italic: false,
        source: "ocr",
        confidence: word.confidence,
        blockId,
        paragraphId,
        lineId,
      });
    }
  }
  return spans;
}
