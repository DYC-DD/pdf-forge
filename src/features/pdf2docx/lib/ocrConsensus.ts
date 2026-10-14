import type { TextSpan } from "../types";

/** Align independent OCR readings before accepting a crop. A higher average
 * score must not overwrite a better-read glyph elsewhere in the same cell.
 * No dictionary or generated replacement text is used.
 */
export function reconcileOcr(
  before: readonly TextSpan[],
  after: readonly TextSpan[]
): TextSpan[] {
  const letters = (spans: readonly TextSpan[]) =>
    spans
      .flatMap((span, word) =>
        Array.from(span.text).map((text, char) => ({
          text,
          word,
          char,
          confidence: span.confidence ?? 0,
        }))
      )
      .filter((c) => !/\s/u.test(c.text));
  const a = letters(before),
    b = letters(after);
  if (!a.length || !b.length || a.length > 400 || b.length > 400)
    return [...after];
  const cols = b.length + 1;
  const distances = new Uint16Array((a.length + 1) * cols);
  for (let i = 0; i <= a.length; i++) distances[i * cols] = i;
  for (let j = 0; j <= b.length; j++) distances[j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      distances[i * cols + j] = Math.min(
        distances[(i - 1) * cols + j] + 1,
        distances[i * cols + j - 1] + 1,
        distances[(i - 1) * cols + j - 1] +
          Number(a[i - 1].text !== b[j - 1].text)
      );
  const text = after.map((s) => Array.from(s.text));
  let i = a.length,
    j = b.length;
  while (i && j) {
    const first = a[i - 1],
      second = b[j - 1];
    if (
      distances[i * cols + j] ===
      distances[(i - 1) * cols + j - 1] + Number(first.text !== second.text)
    ) {
      if (
        first.text !== second.text &&
        first.confidence >= 60 &&
        first.confidence >= second.confidence + 12
      )
        text[second.word][second.char] = first.text;
      i--;
      j--;
    } else if (distances[i * cols + j] === distances[(i - 1) * cols + j] + 1)
      i--;
    else j--;
  }
  return after.map((span, index) => ({ ...span, text: text[index].join("") }));
}
