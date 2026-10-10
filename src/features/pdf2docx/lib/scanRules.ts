import type { Rule } from "../types";
import { DOCX_LIMITS } from "./limits";

type Segment = { position: number; from: number; to: number; count: number };

// Find long, nearly straight strokes in the local scan. Perpendicular dilation
// tolerates scanner skew and broken ink; character strokes are too short to pass.
export function scanRules(
  image: Pick<ImageData, "data" | "width" | "height">,
  scale: number
): Rule[] {
  const { data, width, height } = image;
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++)
    ink[i] = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] < 420 ? 1 : 0;
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
    return merged;
  };
  const horizontal = detect(true),
    vertical = detect(false);
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
