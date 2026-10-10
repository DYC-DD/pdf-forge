import type { Rule, TextSpan } from "../types";
import { bounds, horizontal, right } from "./geometry";
import { buildLines, lineRuns } from "./paragraphs";

// Only recognize a stacked fraction when its bar has a centered numerator and
// denominator, plus an adjacent equation operator on the main baseline. This
// excludes ordinary underlines and table rows.
export function reconstructFractions(
  spans: TextSpan[],
  rules: readonly Rule[]
) {
  const consumed = new Set<Rule>(),
    used = new Set<string>();
  const fractions: TextSpan[] = [];
  const replacements = new Map<string, string>();
  const mathText = (span: TextSpan) => replacements.get(span.id) ?? span.text;
  for (const rule of rules) {
    if (!horizontal(rule)) continue;
    const x = Math.min(rule.x1, rule.x2),
      end = Math.max(rule.x1, rule.x2),
      y = (rule.y1 + rule.y2) / 2;
    const nearby = spans.filter(
      (span) =>
        span.source === "pdf" &&
        !used.has(span.id) &&
        span.text.trim() &&
        span.x >= x - 2 &&
        right(span) <= end + 2
    );
    const numerator = nearby.filter(
      (span) =>
        span.baseline <= y - span.size * 0.3 &&
        span.baseline >= y - span.size * 1.8
    );
    const denominator = nearby.filter(
      (span) =>
        span.y >= y - 1 &&
        span.baseline > y + span.size * 0.3 &&
        span.baseline <= y + span.size * 1.8
    );
    if (!numerator.length || !denominator.length) continue;
    const size = numerator[0].size;
    const nbox = bounds(numerator),
      dbox = bounds(denominator);
    if (
      [nbox, dbox].some(
        (box) =>
          Math.abs(box.x + box.width / 2 - (x + end) / 2) >
          Math.max(3, size * 0.5)
      )
    )
      continue;
    const neighbors = spans.filter(
      (span) =>
        span.source === "pdf" &&
        Math.abs(span.baseline - y) < size * 0.5 &&
        ((right(span) <= x + 2 && x - right(span) < size * 2) ||
          (span.x >= end - 2 && span.x - end < size))
    );
    if (!neighbors.some((span) => /[=×÷]/u.test(span.text))) continue;
    const part = (items: TextSpan[]) =>
      lineRuns(
        buildLines(
          items.map((span) => ({ ...span, text: mathText(span) })),
          true
        )[0]
      )
        .map((run) => run.text)
        .join("");
    if (
      buildLines(numerator, true).length !== 1 ||
      buildLines(denominator, true).length !== 1
    )
      continue;
    // Some embedded Cambria Math subsets expose delimiter glyphs as ASCII
    // punctuation. Repair only a matched pair around this identified fraction;
    // an ampersand or plus inside a real expression must remain unchanged.
    const leftDelimiter = neighbors.find(
      (span) => /CambriaMath/iu.test(span.font) && /×\s*&$/u.test(span.text)
    );
    const rightDelimiter = neighbors.find(
      (span) => /CambriaMath/iu.test(span.font) && /^'/u.test(span.text)
    );
    if (leftDelimiter && rightDelimiter) {
      replacements.set(
        leftDelimiter.id,
        leftDelimiter.text.replace(/&$/u, "(")
      );
      replacements.set(
        rightDelimiter.id,
        rightDelimiter.text.replace(/^'/u, ")")
      );
    }
    const ordered = [...numerator].sort((a, b) => a.x - b.x),
      first = ordered[0],
      last = ordered[ordered.length - 1];
    if (
      /CambriaMath/iu.test(first.font) &&
      /CambriaMath/iu.test(last.font) &&
      /^∑\+/u.test(first.text) &&
      /,$/u.test(last.text)
    ) {
      replacements.set(first.id, first.text.replace(/^∑\+/u, "∑("));
      replacements.set(
        last.id,
        (replacements.get(last.id) ?? last.text).replace(/,$/u, ")")
      );
    }
    const fraction = {
      numerator: part(numerator),
      denominator: part(denominator),
    };
    const ids = [...numerator, ...denominator].map((span) => span.id);
    ids.forEach((id) => used.add(id));
    consumed.add(rule);
    fractions.push({
      ...numerator[0],
      ...bounds([...numerator, ...denominator]),
      x,
      width: end - x,
      id: `${ids[0]}:fraction`,
      ids,
      text: `${fraction.numerator}/${fraction.denominator}`,
      fraction,
      baseline: y + size * 0.3,
    });
  }
  return {
    spans: [
      ...spans
        .filter((span) => !used.has(span.id))
        .map((span) =>
          replacements.has(span.id)
            ? { ...span, text: replacements.get(span.id)! }
            : span
        ),
      ...fractions,
    ],
    consumed,
  };
}
