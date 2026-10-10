import type { Box, Fill, Rule, TableModel, TextSpan } from "../types";
import {
  bounds,
  containsCenter,
  horizontal,
  median,
  right,
  uniquePositions,
  vertical,
} from "./geometry";
import { buildLines, groupParagraphs } from "./paragraphs";

function ruleBox(rule: Rule): Box {
  return {
    x: Math.min(rule.x1, rule.x2),
    y: Math.min(rule.y1, rule.y2),
    width: Math.abs(rule.x2 - rule.x1),
    height: Math.abs(rule.y2 - rule.y1),
  };
}
function touches(a: Rule, b: Rule): boolean {
  const first = ruleBox(a);
  const second = ruleBox(b);
  return (
    first.x <= second.x + second.width + 2 &&
    first.x + first.width + 2 >= second.x &&
    first.y <= second.y + second.height + 2 &&
    first.y + first.height + 2 >= second.y
  );
}

export function detectTables(
  rules: Rule[],
  spans: TextSpan[],
  bodySize: number,
  fills: readonly Fill[] = []
): { tables: TableModel[]; used: Set<string> } {
  const axisRules = rules.filter(
    (rule) =>
      (horizontal(rule) || vertical(rule)) &&
      Math.hypot(rule.x2 - rule.x1, rule.y2 - rule.y1) > 6
  );
  const visited = new Set<number>();
  const tables: TableModel[] = [];
  const used = new Set<string>();
  for (let start = 0; start < axisRules.length; start++) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    const group: Rule[] = [];
    while (queue.length) {
      const index = queue.pop()!;
      const current = axisRules[index];
      group.push(current);
      for (let candidate = 0; candidate < axisRules.length; candidate++) {
        if (!visited.has(candidate) && touches(current, axisRules[candidate])) {
          visited.add(candidate);
          queue.push(candidate);
        }
      }
    }
    const hs = group.filter(horizontal);
    const vs = group.filter(vertical);
    const tolerance = spans[0]?.source === "ocr" ? 4 : 2;
    const xs = uniquePositions(
      vs.map((rule) => (rule.x1 + rule.x2) / 2),
      tolerance
    );
    const ys = uniquePositions(
      hs.map((rule) => (rule.y1 + rule.y2) / 2),
      tolerance
    );
    // A rectangular border alone is not evidence of a table.
    if (xs.length < 3 || ys.length < 3 || xs.length > 41 || ys.length > 201)
      continue;
    const box = {
      x: xs[0],
      y: ys[0],
      width: xs[xs.length - 1] - xs[0],
      height: ys[ys.length - 1] - ys[0],
    };
    const origins = new Map<string, string>();
    const content = spans
      .filter((span) => containsCenter(box, span))
      .flatMap((span) => {
        if (!span.advances || span.source !== "pdf") return [span];
        const characters = Array.from(span.text);
        let x = span.x,
          start = 0,
          startX = x;
        const pieces: TextSpan[] = [];
        for (let i = 0; i < characters.length; i++) {
          const next = x + span.advances[i];
          // Split at a real whitespace gap across a vertical stroke. A glyph
          // protruding slightly into its neighbor is not another cell's text.
          if (
            /\s/u.test(characters[i]) &&
            xs.some(
              (boundary) =>
                boundary > x - 1 &&
                boundary < next + 1 &&
                vs.some(
                  (line) =>
                    Math.abs(line.x1 - boundary) < 2 &&
                    Math.min(line.y1, line.y2) <= span.y + span.height / 2 &&
                    Math.max(line.y1, line.y2) >= span.y + span.height / 2
                )
            )
          ) {
            const id = `${span.id}:cell:${pieces.length}`;
            origins.set(id, span.id);
            pieces.push({
              ...span,
              id,
              text: characters.slice(start, i).join(""),
              x: startX,
              width: x - startX,
              advances: span.advances.slice(start, i),
            });
            start = i + 1;
            startX = next;
          }
          x = next;
        }
        if (!pieces.length) return [span];
        const id = `${span.id}:cell:${pieces.length}`;
        origins.set(id, span.id);
        pieces.push({
          ...span,
          id,
          text: characters.slice(start).join(""),
          x: startX,
          width: right(span) - startX,
          advances: span.advances.slice(start),
        });
        return pieces.filter((piece) => piece.text.trim());
      });
    if (!content.length) continue;
    const gridSize = median(content.map((span) => span.size));
    const columns = xs.length - 1;
    const rows = ys.length - 1;
    const parents = Array.from({ length: rows * columns }, (_, index) => index);
    const root = (index: number): number => {
      while (parents[index] !== index) index = parents[index];
      return index;
    };
    const union = (a: number, b: number) => {
      parents[root(b)] = root(a);
    };
    const covered = (
      lines: Rule[],
      position: number,
      from: number,
      to: number,
      isVertical: boolean
    ) => {
      const segments = lines
        .filter(
          (rule) => Math.abs((isVertical ? rule.x1 : rule.y1) - position) < 2
        )
        .map((rule) =>
          isVertical
            ? [Math.min(rule.y1, rule.y2), Math.max(rule.y1, rule.y2)]
            : [Math.min(rule.x1, rule.x2), Math.max(rule.x1, rule.x2)]
        )
        .sort((a, b) => a[0] - b[0]);
      let end = from;
      for (const [a, b] of segments)
        if (a <= end + 2 && b >= end) end = Math.max(end, b);
      return end >= to - 2;
    };
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        if (
          column + 1 < columns &&
          !covered(vs, xs[column + 1], ys[row], ys[row + 1], true)
        )
          union(index, index + 1);
        if (
          row + 1 < rows &&
          !covered(hs, ys[row + 1], xs[column], xs[column + 1], false)
        )
          union(index, index + columns);
      }
    const groups = new Map<number, number[]>();
    parents.forEach((_, index) => {
      const id = root(index);
      groups.set(id, [...(groups.get(id) ?? []), index]);
    });
    const table: TableModel = {
      ...box,
      kind: "table",
      before: 0,
      columns: xs.slice(1).map((x, index) => x - xs[index]),
      rows: ys.slice(1).map((y, index) => y - ys[index]),
      cells: [],
      border: {
        color: group.find((rule) => rule.color)?.color ?? "000000",
        thickness: median(group.map((rule) => rule.thickness ?? 0.5)),
      },
    };
    let valid = true;
    const localUsed = new Set<string>();
    for (const members of groups.values()) {
      const row = Math.min(
        ...members.map((index) => Math.floor(index / columns))
      );
      const column = Math.min(...members.map((index) => index % columns));
      const rowSpan =
        Math.max(...members.map((index) => Math.floor(index / columns))) -
        row +
        1;
      const columnSpan =
        Math.max(...members.map((index) => index % columns)) - column + 1;
      if (rowSpan * columnSpan !== members.length) {
        valid = false;
        break;
      }
      const cellBox = {
        x: xs[column],
        y: ys[row],
        width: xs[column + columnSpan] - xs[column],
        height: ys[row + rowSpan] - ys[row],
      };
      let cellSpans = content.filter(
        (span) => !localUsed.has(span.id) && containsCenter(cellBox, span)
      );
      // OCR can include a bottom grid stroke in a glyph's height. A swollen
      // type estimate that cannot fit its row should not enlarge the whole row.
      if (
        cellSpans.some(
          (span) =>
            span.source === "ocr" &&
            span.size > gridSize * 1.5 &&
            span.size * 1.25 > cellBox.height
        )
      )
        cellSpans = cellSpans.map((span) =>
          span.source === "ocr" && span.size > gridSize * 1.5
            ? { ...span, size: gridSize }
            : span
        );
      cellSpans.forEach((span) => localUsed.add(span.id));
      const padding = {
        left: cellSpans.length
          ? Math.max(
              0,
              Math.min(
                3,
                Math.min(...cellSpans.map((span) => span.x)) - cellBox.x
              )
            )
          : 3,
        right: cellSpans.length
          ? Math.max(
              0,
              Math.min(3, right(cellBox) - Math.max(...cellSpans.map(right)))
            )
          : 3,
      };
      const inner = {
        ...cellBox,
        x: cellBox.x + padding.left,
        y: cellBox.y + 3,
        width: Math.max(1, cellBox.width - padding.left - padding.right),
      };
      const textBox = bounds(cellSpans);
      const centerDelta = Math.abs(
        textBox.y + textBox.height / 2 - cellBox.y - cellBox.height / 2
      );
      table.cells.push({
        row,
        column,
        rowSpan,
        columnSpan,
        padding,
        paragraphs: groupParagraphs(
          buildLines(cellSpans, true),
          inner,
          bodySize,
          true
        ).map((paragraph) => ({
          ...paragraph,
          ids: [...new Set(paragraph.ids.map((id) => origins.get(id) ?? id))],
          lineHeight: Math.min(
            paragraph.lineHeight,
            cellBox.height / Math.max(1, paragraph.lineCount ?? 1) -
              // Word keeps clearance on both sides of the cell text. Leave
              // room for the frame instead of making every tight row grow.
              2 * (table.border?.thickness ?? 0.5)
          ),
        })),
        fill: [...fills].reverse().find((fill) => containsCenter(fill, cellBox))
          ?.color,
        verticalAlign:
          cellSpans.length && centerDelta < Math.max(3, bodySize * 0.35)
            ? "center"
            : "top",
      });
    }
    if (valid && localUsed.size === content.length) {
      tables.push(table);
      localUsed.forEach((id) => used.add(origins.get(id) ?? id));
    }
  }
  return { tables, used };
}
