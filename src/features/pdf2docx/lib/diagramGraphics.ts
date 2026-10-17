import type { Box, RawPage, TableModel } from "../types";
import { bottom, bounds, containsBox, median, right } from "./geometry";

const intersects = (a: Box, b: Box, padding = 0) =>
  a.x <= right(b) + padding &&
  b.x <= right(a) + padding &&
  a.y <= bottom(b) + padding &&
  b.y <= bottom(a) + padding;

/** Connected artwork with many small labels is a diagram, even without a
 * rectangular frame. Keep labels and paths together instead of reflowing each
 * label as a paragraph. Ordinary prose, grids and isolated logos stay editable.
 */
export function diagramGraphics(
  page: RawPage,
  artwork: readonly Box[],
  tables: readonly TableModel[],
  framed: readonly Box[] = []
): Box[] {
  // Bound the pairwise component search on unusually dense vector pages.
  if (artwork.length > 2000) return [];
  const visible = page.spans.filter(
    (s) => !s.hidden && !s.decorative && s.text.trim()
  );
  const bodySize = median(visible.map((s) => s.size));
  const remaining = new Set(
    artwork.filter(
      (b) =>
        b.width > 2 && b.height > 2 && !framed.some((f) => containsBox(f, b, 2))
    )
  );
  const result: Box[] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    remaining.delete(first);
    const component = [first];
    for (let index = 0; index < component.length; index++) {
      for (const other of remaining) {
        if (!intersects(component[index], other, 8)) continue;
        component.push(other);
        remaining.delete(other);
      }
    }
    if (component.length < 3) continue;
    const box = bounds(component);
    if (
      box.width < 100 ||
      box.height < 70 ||
      box.width * box.height > page.width * page.height * 0.45 ||
      [...tables, ...framed].some((other) => intersects(box, other))
    )
      continue;
    const labels = visible.filter((s) => intersects(box, s));
    if (
      labels.length < 8 ||
      labels.some(
        (s) =>
          !containsBox(box, s, 2) ||
          s.size > bodySize * 0.85 ||
          s.width > box.width * 0.55 ||
          s.text.trim().length > 60
      )
    )
      continue;
    result.push(bounds([box, ...labels]));
  }
  return result;
}
