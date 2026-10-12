import type { Rule } from "../types";
import { DOCX_LIMITS } from "./limits";

type Segment = { position: number; from: number; to: number; count: number };

// Find long, nearly straight strokes in the local scan. Perpendicular dilation
// tolerates scanner skew and broken ink; character strokes are too short to pass.
export function scanRules(
  image: { data: Uint8ClampedArray; width: number; height: number },
  scale: number
): Rule[] {
  const { data, width, height } = image;
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2];
    // Pale gray grid lines still count. Colored stamps/watermarks must not
    // become hundreds of false horizontal/vertical strokes or be erased.
    ink[i] =
      r + g + b < 600 && Math.max(r, g, b) - Math.min(r, g, b) < 40 ? 1 : 0;
  }
  const radius = Math.max(1, Math.round(scale * 0.65));
  const detect = (horizontal: boolean): Segment[] => {
    const length = horizontal ? width : height;
    const breadth = horizontal ? height : width;
    const minimum = Math.round((horizontal ? 30 : 36) * scale);
    const candidates: Segment[] = [];
    for (let position = radius; position < breadth - radius; position++) {
      let start = -1,
        last = -1,
        hits = 0;
      const finish = () => {
        if (last - start >= minimum && hits / (last - start + 1) > 0.86)
          candidates.push({ position, from: start, to: last, count: 1 });
        start = -1;
        hits = 0;
      };
      for (let offset = 0; offset < length; offset++) {
        let black = false;
        for (let delta = -radius; delta <= radius && !black; delta++)
          black =
            !!ink[
              horizontal
                ? (position + delta) * width + offset
                : offset * width + position + delta
            ];
        if (black) {
          if (start < 0) start = offset;
          last = offset;
          hits++;
        } else if (start >= 0 && offset - last > scale) finish();
      }
      if (start >= 0) finish();
    }
    const merged: Segment[] = [];
    for (const candidate of candidates) {
      const match = merged.find(
        (entry) =>
          Math.abs(candidate.position - entry.position) < scale * 2.5 &&
          Math.min(candidate.to, entry.to) -
            Math.max(candidate.from, entry.from) >
            Math.min(candidate.to - candidate.from, entry.to - entry.from) * 0.5
      );
      if (match) {
        match.position =
          (match.position * match.count + candidate.position) /
          (match.count + 1);
        match.count++;
        match.from = Math.min(match.from, candidate.from);
        match.to = Math.max(match.to, candidate.to);
      } else merged.push({ ...candidate });
      if (merged.length > DOCX_LIMITS.rulesPerPage) return [];
    }
    // Dilation of a thick or curved stroke can produce nested segments whose
    // running centroids drift apart; consolidate them before OCR erasure.
    for (let i = 0; i < merged.length; i++)
      for (let j = merged.length - 1; j > i; j--) {
        const a = merged[i],
          b = merged[j];
        if (
          Math.abs(a.position - b.position) > scale * 2.5 ||
          Math.min(a.to, b.to) - Math.max(a.from, b.from) <=
            Math.min(a.to - a.from, b.to - b.from) * 0.5
        )
          continue;
        a.position =
          (a.position * a.count + b.position * b.count) / (a.count + b.count);
        a.count += b.count;
        a.from = Math.min(a.from, b.from);
        a.to = Math.max(a.to, b.to);
        merged.splice(j, 1);
      }
    return merged;
  };
  // Scanner bed shadows and cropped paper edges are not document borders.
  const interior = (line: Segment, extent: number) =>
    line.position > extent * 0.015 && line.position < extent * 0.985;
  const horizontal = detect(true).filter((line) => interior(line, height)),
    vertical = detect(false).filter((line) => interior(line, width));
  // Underlines and form boxes alone are not a grid. The table detector checks
  // intersections and rectangular merged cells before consuming any text.
  if (horizontal.length < 3 || vertical.length < 3) return [];
  return [
    ...horizontal.map((line) => ({
      x1: line.from / scale,
      x2: line.to / scale,
      y1: line.position / scale,
      y2: line.position / scale,
    })),
    ...vertical.map((line) => ({
      y1: line.from / scale,
      y2: line.to / scale,
      x1: line.position / scale,
      x2: line.position / scale,
    })),
  ];
}
