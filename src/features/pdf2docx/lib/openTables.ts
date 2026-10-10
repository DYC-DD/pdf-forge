import type { Rule, TableModel, TextSpan } from "../types";
import {
  bottom,
  bounds,
  horizontal,
  median,
  right,
  vertical,
} from "./geometry";
import { buildLines, groupParagraphs } from "./paragraphs";

// Academic numeric tables often have a header separator and a bottom rule,
// but no vertical grid. Require repeated, aligned numeric rows between both
// rules so ordinary columns, captions, and underlined prose remain text.
export function detectOpenTables(
  rules: Rule[],
  spans: TextSpan[],
  bodySize: number
) {
  const tables: TableModel[] = [];
  const used = new Set<string>();
  const separators = rules
    .filter(horizontal)
    .filter((rule) => Math.abs(rule.x2 - rule.x1) > bodySize * 8)
    .sort((a, b) => a.y1 - b.y1);
  const numeric = /^(?:[-−–—]|[+−-]?\d[\d,.]*(?:[%x×])?)$/u;
  for (const top of separators) {
    const left = Math.min(top.x1, top.x2),
      end = Math.max(top.x1, top.x2);
    const lower = separators.find(
      (rule) =>
        rule.y1 > top.y1 + bodySize * 2 &&
        Math.abs(Math.min(rule.x1, rule.x2) - left) < bodySize * 2 &&
        Math.abs(Math.max(rule.x1, rule.x2) - end) < bodySize * 2
    );
    if (
      !lower ||
      rules.some(
        (rule) =>
          vertical(rule) &&
          rule.x1 >= left - 2 &&
          rule.x1 <= end + 2 &&
          Math.min(rule.y1, rule.y2) < lower.y1 &&
          Math.max(rule.y1, rule.y2) > top.y1
      )
    )
      continue;
    const content = spans.filter(
      (span) =>
        !used.has(span.id) &&
        span.source === "pdf" &&
        span.y >= top.y1 - 1 &&
        bottom(span) <= lower.y1 + 1 &&
        span.x >= left - 1 &&
        right(span) <= end + 1
    );
    const rows = buildLines(content, true);
    if (rows.length < 3 || rows.length > 100) continue;
    const size = median(content.map((span) => span.size));
    if (
      rows.some(
        (row, index) =>
          row.spans.length < 3 ||
          row.spans.filter((span) => numeric.test(span.text.trim())).length <
            Math.max(2, row.spans.length * 0.6) ||
          (index > 0 && row.baseline - rows[index - 1].baseline > size * 1.8)
      )
    )
      continue;
    const header = buildLines(
      spans.filter(
        (span) =>
          !used.has(span.id) &&
          span.source === "pdf" &&
          span.x >= left - 1 &&
          right(span) <= end + 1 &&
          bottom(span) <= top.y1 + 1 &&
          span.y >= top.y1 - size * 1.8
      ),
      true
    );
    if (header.length !== 1 || header[0].spans.length < 2) continue;
    const allRows = [...header, ...rows];
    const allSpans = allRows.flatMap((row) => row.spans);
    const intervals: { x: number; end: number }[] = [];
    for (const span of [...allSpans].sort((a, b) => a.x - b.x)) {
      const previous = intervals[intervals.length - 1];
      if (previous && span.x - previous.end < size * 0.5)
        previous.end = Math.max(previous.end, right(span));
      else intervals.push({ x: span.x, end: right(span) });
    }
    if (intervals.length < 3 || intervals.length > 20) continue;
    const xs = [
      left,
      ...intervals
        .slice(1)
        .map((interval, index) => (interval.x + intervals[index].end) / 2),
      end,
    ];
    const cellIndex = (span: TextSpan) =>
      xs.findIndex(
        (x, index) =>
          index < xs.length - 1 &&
          span.x >= x - 1 &&
          right(span) <= xs[index + 1] + 1
      );
    // Every data row must populate the same columns. Sparse forms and prose
    // with coincidental whitespace are deliberately left to the normal flow.
    if (
      allSpans.some((span) => cellIndex(span) < 0) ||
      rows.some(
        (row) => new Set(row.spans.map(cellIndex)).size !== intervals.length
      )
    )
      continue;
    const ys = [
      header[0].y,
      top.y1,
      ...rows.slice(1).map((row, index) => (row.y + bottom(rows[index])) / 2),
      lower.y1,
    ];
    const table: TableModel = {
      kind: "table",
      x: left,
      y: ys[0],
      width: end - left,
      height: lower.y1 - ys[0],
      before: 0,
      columns: xs.slice(1).map((x, index) => x - xs[index]),
      rows: ys.slice(1).map((y, index) => y - ys[index]),
      borderless: true,
      horizontalBorders: [
        {
          boundary: 1,
          color: top.color ?? "000000",
          thickness: top.thickness ?? 0.5,
        },
        {
          boundary: allRows.length,
          color: lower.color ?? "000000",
          thickness: lower.thickness ?? 0.5,
        },
      ],
      cells: [],
    };
    allRows.forEach((row, rowIndex) => {
      intervals.forEach((_, column) => {
        const entries = row.spans.filter((span) => cellIndex(span) === column);
        const region = {
          x: xs[column],
          y: ys[rowIndex],
          width: table.columns[column],
          height: table.rows[rowIndex],
        };
        const textBox = bounds(entries);
        const padding = {
          left: Math.max(0, Math.min(3, textBox.x - region.x)),
          right: Math.max(0, Math.min(3, right(region) - right(textBox))),
        };
        table.cells.push({
          row: rowIndex,
          column,
          rowSpan: 1,
          columnSpan: 1,
          padding,
          verticalAlign: "center",
          paragraphs: groupParagraphs(
            buildLines(entries, true),
            {
              ...region,
              x: region.x + padding.left,
              width: region.width - padding.left - padding.right,
            },
            bodySize,
            true
          ).map((paragraph) => ({
            ...paragraph,
            role: "body",
            before: 0,
            lineHeight: Math.max(
              size,
              Math.min(paragraph.lineHeight, region.height - 0.5)
            ),
          })),
        });
      });
    });
    tables.push(table);
    allSpans.forEach((span) => used.add(span.id));
  }
  return { tables, used };
}
