import type { Box, Rule } from "../types";
import { bottom, bounds, median, right } from "./geometry";
import type { TextLine } from "./paragraphs";

export type ScanParagraph = Box & { lines: TextLine[] };
const text = (line: TextLine) =>
  line.spans
    .map((s) => s.text)
    .join("")
    .trim();
const marker =
  /^(?:[•●▪◦‣]|\d{1,3}[.)、](?!\d)|[（(][\d一二三四五六七八九十]+[)）]|[一二三四五六七八九十百]+[、．.]|第[一二三四五六七八九十百\d]+條)/u;

/** Visual paragraph units for the text/image decision. OCR paragraph IDs are
 * deliberately hints only: a watermark often splits one paragraph into many
 * OCR blocks, while a dense form may put several unrelated fields in one ID.
 */
export function scanParagraphs(
  lines: readonly TextLine[],
  rules: readonly Rule[] = [],
  obstacles: readonly Box[] = []
): ScanParagraph[] {
  if (!lines.length) return [];
  const ordered = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  // Measure repeated leading, including double-spaced scanned contracts.
  const pitches = ordered.slice(1).flatMap((line, i) => {
    const prev = ordered[i],
      size = (prev.size + line.size) / 2;
    const gap = line.baseline - prev.baseline;
    return gap >= size * 0.8 &&
      gap <= size * 3.3 &&
      Math.abs(line.x - prev.x) <= size * 3 &&
      Math.abs(line.size - prev.size) <= size * 0.2
      ? [gap / size]
      : [];
  });
  const leading = pitches.length ? median(pitches) : 1.5;
  const result: ScanParagraph[] = [];
  let current: TextLine[] = [];
  const finish = () => {
    if (current.length) result.push({ ...bounds(current), lines: current });
    current = [];
  };
  for (const line of ordered) {
    const previous = current.at(-1);
    if (previous) {
      const first = current[0],
        size = median(current.map((l) => l.size));
      const gap = line.baseline - previous.baseline;
      const overlap =
        Math.min(right(line), right(previous)) - Math.max(line.x, previous.x);
      const left = Math.min(...current.map((l) => l.x));
      const edge = Math.max(...current.map(right), right(line));
      const previousText = text(previous);
      const hanging =
        marker.test(text(first)) &&
        line.x >= first.x - size * 0.4 &&
        line.x <= first.x + size * 4;
      const indentedStart =
        line.x - left > size * 0.8 &&
        !hanging &&
        (current.length > 1 || /[。！？.!?]$/u.test(previousText));
      const shortEnd =
        right(previous) < edge - size * 2 && /[。！？.!?]$/u.test(previousText);
      const separator = rules.some(
        (r) =>
          Math.abs(r.y2 - r.y1) < 1 &&
          r.y1 >= bottom(previous) &&
          r.y1 <= line.y &&
          Math.min(r.x1, r.x2) < edge &&
          Math.max(r.x1, r.x2) > left
      );
      const obstacle = obstacles.some(
        (b) =>
          b.y < line.y &&
          bottom(b) > bottom(previous) &&
          b.x < edge &&
          right(b) > left
      );
      // A short colon-terminated label/title is independent of the next body.
      const label = /[:：]$/u.test(previousText);
      const shortHeading =
        current.length === 1 &&
        previous.width < line.width * 0.6 &&
        Array.from(previousText).length < 24;
      if (
        gap < size * 0.65 ||
        gap > size * Math.max(1.8, Math.min(3.3, leading * 1.3)) ||
        Math.abs(line.size - size) > size * 0.22 ||
        overlap < Math.min(line.width, previous.width) * 0.35 ||
        marker.test(text(line)) ||
        indentedStart ||
        shortEnd ||
        label ||
        shortHeading ||
        separator ||
        obstacle ||
        (Math.abs(line.x - previous.x) > size * 3 && !hanging)
      )
        finish();
    }
    current.push(line);
  }
  finish();
  return result;
}
