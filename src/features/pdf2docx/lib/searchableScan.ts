import type { TextSpan } from "../types";
import { right } from "./geometry";
import { buildLines } from "./paragraphs";

const normalized = (text: string) => text.normalize("NFKC").replace(/\s/gu, "");

/** Neither an old searchable layer nor fresh OCR is ground truth. If the two
 * disagree on an aligned row, retain that paragraph's image instead of silently
 * replacing a fraction, digit or word with the new OCR hypothesis.
 */
export function markSearchableScanDisagreements(
  spans: TextSpan[],
  reference: readonly TextSpan[]
): void {
  if (!reference.length) return;
  const source = buildLines([...reference], true);
  for (const line of buildLines(spans, true)) {
    const nearby = source
      .filter(
        (candidate) =>
          Math.abs(candidate.baseline - line.baseline) <=
            Math.max(candidate.size, line.size) * 1.5 &&
          Math.min(right(candidate), right(line)) -
            Math.max(candidate.x, line.x) >
            Math.min(candidate.width, line.width) * 0.5
      )
      .sort(
        (a, b) =>
          Math.abs(a.baseline - line.baseline) -
          Math.abs(b.baseline - line.baseline)
      );
    if (!nearby.length) continue;
    const text = (items: TextSpan[]) =>
      normalized(items.map((s) => s.text).join(""));
    if (text(line.spans) !== text(nearby[0].spans))
      line.spans.forEach((span) => {
        span.sourceMismatch = true;
      });
  }
}
