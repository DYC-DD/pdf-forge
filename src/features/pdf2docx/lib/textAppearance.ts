import { OPS } from "pdfjs-dist";

import type { TextSpan } from "../types";

type Operators = { fnArray: ArrayLike<number>; argsArray: any[] };
type PaintGlyph = { unicode?: string; width?: number; isInFont?: boolean };
type Appearance = {
  text: string;
  color: string;
  bold: boolean;
  invisible: boolean;
  order: number;
  terminalHyphenGlyphs?: (PaintGlyph | number)[];
  sourceText: string;
};

// A single paint operation can become several PDF.js text items at large TJ
// gaps. Measure only the suffix owned by the last item, not the entire line.
function terminalHyphenRatio(
  appearance: Appearance,
  text: string
): number | undefined {
  const glyphs = appearance.terminalHyphenGlyphs;
  if (!glyphs || !appearance.sourceText.endsWith(text + "\u00ad")) return;
  const start = appearance.sourceText.length - text.length - 1;
  let offset = appearance.sourceText.length,
    advance = 0;
  const width = (glyphs.at(-1) as PaintGlyph).width!;
  for (let i = glyphs.length - 1; i >= 0; i--) {
    const glyph = glyphs[i];
    if (typeof glyph === "number") {
      advance -= glyph;
      continue;
    }
    offset -= (glyph.unicode ?? "").length;
    advance += glyph.width ?? NaN;
    if (offset < start) return; // Never split a multi-character glyph.
    if (offset === start)
      return Number.isFinite(advance) && advance > width
        ? width / (advance - width)
        : undefined;
  }
}

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
  operators: Operators,
  lineEnds: ReadonlySet<string> = new Set()
): void {
  const painted: Appearance[] = [];
  const weights: number[] = [];
  let color = "000000",
    mode = 0,
    charSpacing = 0,
    wordSpacing = 0;
  const stack: {
    color: string;
    mode: number;
    charSpacing: number;
    wordSpacing: number;
  }[] = [];
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      args = operators.argsArray[i];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({ color, mode, charSpacing, wordSpacing });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd)
      ({ color, mode, charSpacing, wordSpacing } = stack.pop() ?? {
        color: "000000",
        mode: 0,
        charSpacing: 0,
        wordSpacing: 0,
      });
    else if (op === OPS.setFillRGBColor)
      color =
        typeof args[0] === "string"
          ? args[0].replace("#", "").toUpperCase()
          : color;
    else if (op === OPS.setTextRenderingMode) mode = args[0];
    else if (op === OPS.setCharSpacing) charSpacing = args[0];
    else if (op === OPS.setWordSpacing) wordSpacing = args[0];
    else if (op === OPS.showText) {
      const glyphs = args[0] as (
        { unicode?: string; width?: number; isInFont?: boolean } | number
      )[];
      const last = glyphs.at(-1);
      // PDF.js omits U+00AD even when the PDF paints a real hyphen. Only
      // recover a terminal, present glyph with positive advance. With zero
      // character/word spacing, the width ratio includes TJ adjustments and
      // cancels font size, horizontal scaling and the page transform.
      const terminalHyphenGlyphs =
        mode <= 2 &&
        charSpacing === 0 &&
        wordSpacing === 0 &&
        typeof last === "object" &&
        last.unicode === "\u00ad" &&
        last.isInFont === true &&
        (last.width ?? 0) > 0
          ? glyphs
          : undefined;
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
      const sourceText = (args[0] as ({ unicode?: string } | number)[])
        .map((glyph) =>
          typeof glyph === "number" ? "" : (glyph.unicode ?? "")
        )
        .join("");
      const text = sourceText.replace(/\s/gu, "");
      if (text)
        painted.push({
          text,
          color,
          bold: mode === 1 || mode === 2,
          invisible: mode === 3 || mode === 7,
          order: i,
          terminalHyphenGlyphs,
          sourceText,
        });
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
  let matchedPrefix:
    { appearance: Appearance; to: number; span: TextSpan } | undefined;
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
      ) {
        matchedPrefix = undefined;
        continue;
      }
      start = cursor + relative;
    }
    let to = start + text.length;
    while (rangeIndex < ranges.length && ranges[rangeIndex].to <= start)
      rangeIndex++;
    const appearances: Appearance[] = [];
    for (let i = rangeIndex; i < ranges.length && ranges[i].from < to; i++)
      appearances.push(ranges[i].appearance);
    const appearance = appearances[0];
    const verifiedPrefix =
      appearances.length === 1 &&
      ((ranges[rangeIndex].from === start &&
        appearance.sourceText.startsWith(span.text)) ||
        (matchedPrefix?.appearance === appearance &&
          matchedPrefix.to === start &&
          Math.abs(matchedPrefix.span.baseline - span.baseline) < 0.1 &&
          matchedPrefix.span.font === span.font &&
          matchedPrefix.span.size === span.size &&
          matchedPrefix.span.fontScale === span.fontScale &&
          span.x >= matchedPrefix.span.x + matchedPrefix.span.width - 0.1));
    if (
      lineEnds.has(span.id) &&
      !span.rotation &&
      span.width > 0 &&
      verifiedPrefix &&
      to === ranges[rangeIndex].to - 1
    ) {
      const ratio = terminalHyphenRatio(appearance, span.text);
      if (ratio !== undefined && ratio < 0.25) {
        // Use a visible hyphen: Word can hide a discretionary soft hyphen even
        // at an explicit PDF line break. Keep its source advance as well.
        span.text += "-";
        span.width *= 1 + ratio;
        to++;
      }
    }
    matchedPrefix = verifiedPrefix ? { appearance, to, span } : undefined;
    if (
      appearances.length &&
      appearances.every((run) => run.color === appearances[0].color)
    )
      span.color = appearances[0].color;
    if (appearances.length && appearances.every((run) => run.bold))
      span.bold = true;
    if (appearances.length && appearances.every((run) => run.invisible))
      span.invisible = true;
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
