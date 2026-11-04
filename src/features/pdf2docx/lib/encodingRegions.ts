import type { Box, RawPage, TableModel } from "../types";
import { bottom, containsBox, containsCenter, right } from "./geometry";

export const uncertainEncoding = /[\uFFFD\u0000-\u0008\uE000-\uF8FF\p{Cn}]/u;

/** Localize broken character maps only when a native grid bounds every error. */
export function encodingRegions(raw: RawPage, tables: TableModel[]): Box[] {
  const visible = raw.spans.filter(
    (span) => !span.hidden && !span.rasterized && span.text.trim()
  );
  const uncertain = visible.filter((span) => uncertainEncoding.test(span.text));
  if (!uncertain.length) return [];
  const area = raw.width * raw.height;
  const regions: Box[] = [];
  for (const table of tables) {
    for (const cell of table.cells) {
      const box: Box = {
        x:
          table.x +
          table.columns.slice(0, cell.column).reduce((a, b) => a + b, 0),
        y: table.y + table.rows.slice(0, cell.row).reduce((a, b) => a + b, 0),
        width: table.columns
          .slice(cell.column, cell.column + cell.columnSpan)
          .reduce((a, b) => a + b, 0),
        height: table.rows
          .slice(cell.row, cell.row + cell.rowSpan)
          .reduce((a, b) => a + b, 0),
      };
      if (!uncertain.some((span) => containsCenter(box, span))) continue;
      // Reject large/ambiguous crops and lettering crossing a grid boundary.
      if (
        box.width <= 3 ||
        box.height <= 3 ||
        box.width * box.height > area * 0.05 ||
        !containsBox(
          { x: 0, y: 0, width: raw.width, height: raw.height },
          box
        ) ||
        visible.some(
          (span) =>
            Math.min(right(box), right(span)) - Math.max(box.x, span.x) > 1 &&
            Math.min(bottom(box), bottom(span)) - Math.max(box.y, span.y) > 1 &&
            !containsBox(box, span, 1)
        )
      )
        return [];
      regions.push(box);
    }
  }
  if (
    !regions.length ||
    regions.length > 8 ||
    regions.reduce((sum, box) => sum + box.width * box.height, 0) >
      area * 0.12 ||
    uncertain.some((span) => !regions.some((box) => containsBox(box, span, 1)))
  )
    return [];
  const retained = visible.filter(
    (span) => !regions.some((box) => containsCenter(box, span))
  );
  if (retained.reduce((sum, span) => sum + span.text.trim().length, 0) < 100)
    return [];
  // Commit only after every uncertain span is covered. A partial crop must not
  // suppress the normal OCR/error path for an uncovered mapping failure.
  for (const span of visible) {
    if (regions.some((box) => containsCenter(box, span)))
      span.rasterized = true;
  }
  raw.issues = raw.issues.filter((issue) => issue.code !== "encoding");
  raw.issues.push({
    page: raw.number,
    code: "encoding-region",
    severity: "review",
    message:
      "部分儲存格的文字編碼無法確認，已保留該儲存格原圖；其中文字無法編輯，其他儲存格仍保留原生文字，請核對原稿。",
  });
  return regions;
}
