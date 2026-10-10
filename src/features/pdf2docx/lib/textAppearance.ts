import { OPS } from "pdfjs-dist";

import type { TextSpan } from "../types";

type Operators = { fnArray: ArrayLike<number>; argsArray: any[] };
type Appearance = { text: string; color: string; bold: boolean; order: number };

export function pdfFontName(name: string): string {
  let value = name.replace(/^[A-Z]{6}\+/, "");
  if (/^[\x00-\xFF]+$/u.test(value) && /[\x80-\xFF]/u.test(value)) {
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(value, (c) => c.charCodeAt(0))
      );
    } catch {
      /* A genuine Latin font name is already usable. */
    }
  }
  return value;
}

// PDF.js exposes text geometry separately from paint state. Associate paint
// runs by Unicode content, refusing ambiguous mismatches rather than guessing.
export function applyTextAppearance(
  spans: TextSpan[],
  operators: Operators
): void {
  const painted: Appearance[] = [];
  const weights: number[] = [];
  let color = "000000",
    mode = 0;
  const stack: { color: string; mode: number }[] = [];
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      args = operators.argsArray[i];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({ color, mode });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd)
      ({ color, mode } = stack.pop() ?? { color: "000000", mode: 0 });
    else if (op === OPS.setFillRGBColor)
      color =
        typeof args[0] === "string"
          ? args[0].replace("#", "").toUpperCase()
          : color;
    else if (op === OPS.setTextRenderingMode) mode = args[0];
    else if (op === OPS.showText) {
      for (const glyph of args[0] as (
        { unicode?: string; width?: number } | number
      )[]) {
        if (typeof glyph === "number") continue;
        const characters = Array.from(glyph.unicode ?? "");
        for (const character of characters)
          if (!/\s/u.test(character))
            for (let unit = 0; unit < character.length; unit++)
              weights.push(
                (glyph.width ?? 1000) /
                  Math.max(1, characters.length) /
                  character.length
              );
      }
      const text = (args[0] as ({ unicode?: string } | number)[])
        .map((glyph) =>
          typeof glyph === "number" ? "" : (glyph.unicode ?? "")
        )
        .join("")
        .replace(/\s/gu, "");
      if (text)
        painted.push({ text, color, bold: mode === 1 || mode === 2, order: i });
    }
  }
  const stream = painted.map((run) => run.text).join("");
  const ranges: { from: number; to: number; appearance: Appearance }[] = [];
  let end = 0;
  for (const appearance of painted) {
    ranges.push({ from: end, to: end + appearance.text.length, appearance });
    end += appearance.text.length;
  }
  let cursor = 0,
    rangeIndex = 0;
  for (const span of spans) {
    const text = span.text.replace(/\s/gu, "");
    if (!text) continue;
    let start = cursor;
    if (!stream.startsWith(text, start)) {
      // A paint-only glyph can be omitted by getTextContent. Resynchronize only
      // to a unique nearby match; an ambiguity must not recolor later content.
      const nearby = stream.slice(cursor, cursor + 64 + text.length);
      const relative = nearby.indexOf(text);
      if (
        relative < 0 ||
        relative > 64 ||
        nearby.indexOf(text, relative + 1) >= 0
      )
        continue;
      start = cursor + relative;
    }
    const to = start + text.length;
    while (rangeIndex < ranges.length && ranges[rangeIndex].to <= start)
      rangeIndex++;
    const appearances: Appearance[] = [];
    for (let i = rangeIndex; i < ranges.length && ranges[i].from < to; i++)
      appearances.push(ranges[i].appearance);
    if (
      appearances.length &&
      appearances.every((run) => run.color === appearances[0].color)
    )
      span.color = appearances[0].color;
    if (appearances.length && appearances.every((run) => run.bold))
      span.bold = true;
    if (appearances.length)
      span.paintOrder = Math.max(...appearances.map((run) => run.order));
    let position = start;
    const advances = Array.from(span.text, (character) => {
      if (/\s/u.test(character)) return 250;
      const weight = weights
        .slice(position, position + character.length)
        .reduce((sum, value) => sum + value, 0);
      position += character.length;
      return weight;
    });
    const total = advances.reduce((sum, value) => sum + value, 0);
    if (total > 0 && advances.every((value) => value >= 0))
      span.advances = advances.map((value) => (value * span.width) / total);
    cursor = to;
  }
}
