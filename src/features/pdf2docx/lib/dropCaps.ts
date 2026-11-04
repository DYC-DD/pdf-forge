import type { TextSpan } from "../types";
import { right } from "./geometry";
import { buildLines } from "./paragraphs";

// Identify only a native capital beside 2–4 complete lines followed by text
// returning to its left edge. Tall symbols, headings and isolated initials
// have no such wrap evidence and must stay in the ordinary text flow.
export function findDropCaps(spans: TextSpan[], bodySize: number): TextSpan[] {
  const candidates = spans.filter((cap) => {
    if (
      cap.source !== "pdf" ||
      cap.rotation ||
      !/^\p{Lu}$/u.test(cap.text) ||
      !/^\p{Script=Latin}$/u.test(cap.text) ||
      spans.some(
        (other) => other !== cap && other.text.trim() && other.y < cap.y - 1
      ) ||
      cap.size < bodySize * 2.5 ||
      cap.size > bodySize * 6
    )
      return false;
    const lines = buildLines(
      spans.filter((s) => s !== cap && s.text.trim()),
      true
    );
    const beside = lines.filter(
      (line) =>
        line.baseline <= cap.baseline + 0.5 &&
        line.y >= cap.y &&
        Math.abs(line.x - right(cap)) < bodySize * 0.5 &&
        Math.abs(line.size - bodySize) < 0.5 &&
        line.width > bodySize * 5 &&
        line.spans.every(
          (s) => s.source === "pdf" && !s.rotation && s.font === cap.font
        )
    );
    if (beside.length < 2 || beside.length > 4) return false;
    const first = beside[0],
      last = beside.at(-1)!;
    if (
      first.y - cap.y > cap.size * 0.4 ||
      Math.abs(last.baseline - cap.baseline) > bodySize * 0.2
    )
      return false;
    if (
      !/^\p{Ll}/u.test(first.spans[0].text) ||
      beside.some((line) =>
        line.spans.some((span) => /\p{Sm}/u.test(span.text))
      )
    )
      return false;
    const leading = (last.baseline - first.baseline) / (beside.length - 1);
    if (
      leading < bodySize ||
      leading > bodySize * 1.6 ||
      beside.some(
        (line, i) => Math.abs(line.baseline - first.baseline - i * leading) > 1
      )
    )
      return false;
    return lines.some(
      (line) =>
        Math.abs(line.baseline - last.baseline - leading) < 1 &&
        Math.abs(line.x - cap.x) < 1 &&
        Math.abs(right(line) - right(last)) < bodySize &&
        Math.abs(line.size - bodySize) < 0.5
    );
  });
  // Multiple initials need per-paragraph anchors to preserve reading order.
  return candidates.length === 1 ? candidates : [];
}
