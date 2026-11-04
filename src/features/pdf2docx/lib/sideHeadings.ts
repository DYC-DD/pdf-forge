import type { TextSpan } from "../types";
import { bottom, right } from "./geometry";
import { buildLines, type TextLine } from "./paragraphs";

// A short large title at the upper left can share its vertical band with
// independent smaller header lines. It must not consume a separate flow row.
export function findSideHeading(
  spans: TextSpan[],
  bodySize: number,
  pageWidth: number
): TextLine | undefined {
  const visible = spans.filter((s) => s.text.trim());
  if (!visible.length) return;
  const top = Math.min(...visible.map((s) => s.y)),
    left = Math.min(...visible.map((s) => s.x));
  const lines = buildLines(visible);
  const candidates = lines.filter((line) => {
    if (
      line.y > top + 2 ||
      line.x > left + bodySize / 2 ||
      line.width > pageWidth * 0.25 ||
      // Some font metrics produce a box much taller than the nominal type.
      // That box cannot safely place a frame or establish the shared band.
      line.height > line.size * 1.25 ||
      line.size < bodySize * 2 ||
      line.size > bodySize * 4 ||
      line.spans
        .map((s) => s.text)
        .join("")
        .replace(/\s/gu, "").length < 2 ||
      line.spans.some(
        (s) =>
          s.source !== "pdf" ||
          s.rotation ||
          s.oblique ||
          s.fraction ||
          /[\p{Sm}\p{Script=Arabic}\p{Script=Hebrew}]/u.test(s.text)
      )
    )
      return false;
    const beside = lines.filter(
      (other) =>
        other !== line &&
        other.x >= right(line) + bodySize &&
        other.y < bottom(line) &&
        bottom(other) > line.y &&
        other.size <= line.size * 0.7 &&
        other.spans.every(
          (s) => s.source === "pdf" && !s.rotation && !s.oblique
        )
    );
    if (beside.length < 2) return false;
    return !visible.some(
      (s) =>
        !line.spans.includes(s) &&
        Math.min(right(s), right(line)) - Math.max(s.x, line.x) > 1 &&
        Math.min(bottom(s), bottom(line)) - Math.max(s.y, line.y) >
          bodySize * 0.5
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}
