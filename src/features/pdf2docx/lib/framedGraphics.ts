import type { Box, RawPage, TableModel } from "../types";
import {
  bottom,
  bounds,
  containsBox,
  containsCenter,
  horizontal,
  right,
  vertical,
} from "./geometry";

/** A framed plot is a single illustration: flowing its axis labels as body
 * paragraphs changes both their positions and the height of the whole page.
 * Require a closed frame, artwork and several short numeric labels. Ordinary
 * text boxes and actual cell grids remain editable.
 */
export function framedGraphics(
  page: RawPage,
  artwork: readonly Box[],
  tables: readonly TableModel[]
): Box[] {
  const hs = page.rules.filter(horizontal);
  const vs = page.rules.filter(vertical);
  const regions: Box[] = [];
  for (const left of vs) {
    const y = Math.min(left.y1, left.y2),
      height = Math.abs(left.y2 - left.y1);
    if (height < 70) continue;
    for (const end of vs) {
      const width = end.x1 - left.x1;
      if (
        width < 150 ||
        Math.abs(Math.min(end.y1, end.y2) - y) > 2 ||
        Math.abs(Math.abs(end.y2 - end.y1) - height) > 2
      )
        continue;
      const box = { x: left.x1, y, width, height };
      if (width * height > page.width * page.height * 0.7) continue;
      const edge = (at: number) =>
        hs.some(
          (r) =>
            Math.abs(r.y1 - at) < 2 &&
            Math.min(r.x1, r.x2) <= box.x + 2 &&
            Math.max(r.x1, r.x2) >= right(box) - 2
        );
      if (!edge(y) || !edge(bottom(box))) continue;
      if (tables.some((t) => containsCenter(box, t) || containsCenter(t, box)))
        continue;
      const spans = page.spans.filter(
        (s) => !s.hidden && !s.decorative && containsCenter(box, s)
      );
      // Do not crop a sentence or an illustration that crosses the frame.
      if (spans.some((s) => !containsBox(box, s, 1))) continue;
      if (
        spans.filter((s) => /\d/u.test(s.text)).length < 3 ||
        spans.some((s) => s.width > width * 0.7)
      )
        continue;
      const art = artwork.filter((b) => containsBox(box, b, 2));
      if (!art.some((b) => b.width > width * 0.15 && b.height > height * 0.1))
        continue;
      // Soft masks can extend slightly beyond the visible frame. Retain their
      // full bounds with the chart; replaying an isolated mask over the complete
      // chart would cover its labels and colors. Never absorb nearby body text.
      const overflow = artwork.filter((b) => {
        const intersection =
          Math.max(0, Math.min(right(box), right(b)) - Math.max(box.x, b.x)) *
          Math.max(0, Math.min(bottom(box), bottom(b)) - Math.max(box.y, b.y));
        return (
          containsBox(box, b, 12) && intersection >= b.width * b.height * 0.9
        );
      });
      const extent = bounds([box, ...overflow]);
      if (
        page.spans.some(
          (s) =>
            !s.hidden &&
            !s.decorative &&
            containsCenter(extent, s) &&
            !containsCenter(box, s)
        )
      )
        continue;
      // Nested frames must not duplicate the same chart.
      if (regions.some((b) => containsCenter(b, box))) continue;
      regions.push(extent);
    }
  }
  return regions.filter(
    (b) =>
      !regions.some(
        (other) =>
          other !== b &&
          other.width * other.height > b.width * b.height &&
          containsCenter(other, b)
      )
  );
}
