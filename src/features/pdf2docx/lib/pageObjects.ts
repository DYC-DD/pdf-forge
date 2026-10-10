import type { RawPage, RuleBlock } from "../types";
import { reconstructFractions } from "./fractions";
import { containsCenter, horizontal, median } from "./geometry";
import { detectOpenTables } from "./openTables";
import { buildLines } from "./paragraphs";
import { detectTables } from "./tables";

// Classify primitives before reading order or paragraph reconstruction. Each
// text span is claimed once; a grid owns its cells, and decoration stays out of
// body flow. This shared stage handles native PDFs and OCR geometry alike.
export function recurringFooterIds(pages: readonly RawPage[]): Set<string> {
  const groups = new Map<string, { pages: Set<number>; ids: string[] }>();
  for (const [index, page] of pages.entries())
    for (const span of page.spans) {
      if (
        span.hidden ||
        span.decorative ||
        !span.text.trim() ||
        span.y < page.height * 0.92
      )
        continue;
      const key = `${Math.round(page.width)}:${Math.round(page.height)}:${Math.round(span.x / 5)}:${Math.round(span.y / 5)}:${span.text.trim()}`;
      const group = groups.get(key) ?? { pages: new Set<number>(), ids: [] };
      group.pages.add(index);
      group.ids.push(span.id);
      groups.set(key, group);
    }
  return new Set(
    [...groups.values()]
      .filter((group) => group.pages.size >= 2)
      .flatMap((group) => group.ids)
  );
}

export function classifyPage(
  page: RawPage,
  recurring: ReadonlySet<string> = new Set()
) {
  const spans = page.spans
    .map((span) => ({ ...span }))
    .filter(
      (span) =>
        span.text.trim().length > 0 &&
        !span.decorative &&
        !span.hidden &&
        !span.rasterized &&
        Number.isFinite(span.x) &&
        Number.isFinite(span.y) &&
        span.size > 0
    );
  const bodySize = median(spans.map((span) => span.size));
  // A grid claims its text before footer detection so a bottom-row amount
  // cannot be mistaken for a page number.
  const { tables, used } = detectTables(
    page.rules,
    spans,
    bodySize,
    page.fills
  );
  const openTables = detectOpenTables(
    page.rules,
    spans.filter((span) => !used.has(span.id)),
    bodySize
  );
  tables.push(...openTables.tables);
  openTables.used.forEach((id) => used.add(id));
  const unclaimed = spans.filter((span) => !used.has(span.id));
  const footerLine =
    page.source === "ocr"
      ? buildLines(unclaimed, true).find(
          (line) =>
            /^\d{1,4}$/u.test(
              line.spans
                .map((span) => span.text)
                .join("")
                .trim()
            ) &&
            line.y > page.height * 0.88 &&
            line.width < page.width * 0.08 &&
            Math.abs(line.x + line.width / 2 - page.width / 2) <
              page.width * 0.08
        )
      : buildLines(unclaimed, true).find(
          (line) =>
            line.y > page.height * 0.92 &&
            (/^\s*(?:第\s*\d{1,4}\s*頁(?:[，,]?\s*共\s*\d{1,4}\s*頁)?|page\s+\d{1,4}(?:\s+of\s+\d{1,4})?|\d{1,4}\s*[\/／]\s*\d{1,4})\s*$/iu.test(
              line.spans.map((span) => span.text).join("")
            ) ||
              line.spans.every(
                (span) =>
                  recurring.has(span.id) ||
                  (/^\d{1,4}$/u.test(span.text.trim()) &&
                    span.width < page.width * 0.08 &&
                    span.size <= bodySize * 1.4)
              ))
        );
  const footerIds = new Set(footerLine?.spans.map((span) => span.id));
  const fractions = reconstructFractions(
    spans.filter((span) => !used.has(span.id) && !footerIds.has(span.id)),
    page.rules.filter(
      (rule) =>
        !tables.some((table) =>
          containsCenter(
            table,
            {
              x: rule.x1,
              y: rule.y1,
              width: rule.x2 - rule.x1,
              height: rule.y2 - rule.y1,
            },
            4
          )
        )
    )
  );
  const body = [
    ...spans.filter((span) => used.has(span.id)),
    ...fractions.spans,
  ];
  const lines: RuleBlock[] = [];
  for (const rule of page.rules) {
    if (fractions.consumed.has(rule)) continue;
    if (!horizontal(rule)) continue;
    if (page.source === "pdf" && rule.y1 > page.height * 0.92) continue;
    const box = {
      x: Math.min(rule.x1, rule.x2),
      y: (rule.y1 + rule.y2) / 2,
      width: Math.abs(rule.x2 - rule.x1),
      height: rule.thickness ?? 0.5,
    };
    if (tables.some((table) => containsCenter(table, box, 4))) continue;
    const underlined = body.filter(
      (span) =>
        span.baseline < box.y + 1 &&
        box.y - span.baseline < span.size * 0.25 &&
        span.x >= box.x - 2 &&
        span.x + span.width <= box.x + box.width + 2
    );
    if (underlined.length) {
      underlined.forEach((span) => {
        span.underline = true;
      });
      continue;
    }
    if (
      box.width < 24 ||
      lines.some(
        (line) =>
          Math.abs(line.y - box.y) < 2 &&
          Math.abs(line.x - box.x) < 2 &&
          Math.abs(line.width - box.width) < 4
      )
    )
      continue;
    lines.push({
      ...box,
      kind: "rule",
      before: 0,
      color: rule.color ?? "000000",
      thickness: rule.thickness ?? 0.5,
    });
  }
  const overlay = (figure: RawPage["figures"][number]) =>
    figure.overlay ||
    (page.source === "pdf" &&
      (tables.some((table) => containsCenter(table, figure)) ||
        (figure.width * figure.height > page.width * page.height * 0.15 &&
          body.some(
            (span) =>
              span.y < figure.y + figure.height &&
              span.y + span.height > figure.y
          )))) ||
    (page.source === "pdf" &&
      figure.y < page.height * 0.15 &&
      figure.width < page.width * 0.2 &&
      body.some(
        (span) =>
          span.size > bodySize * 1.2 &&
          span.y < figure.y + figure.height &&
          span.y + span.height > figure.y
      ));
  const figures = page.figures.filter((figure) => !overlay(figure));
  const overlays = page.figures
    .filter(overlay)
    .map((figure) =>
      figure.inFooter && !footerLine ? { ...figure, inFooter: false } : figure
    );
  return {
    spans,
    bodySize,
    footerLine,
    footerIds,
    tables,
    lines,
    figures,
    overlays,
    text: body.filter((span) => !used.has(span.id)),
  };
}
