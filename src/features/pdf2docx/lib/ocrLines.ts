import { PSM, type Worker } from "tesseract.js";

import type { RawPage, TextSpan } from "../types";
import { bounds, median } from "./geometry";
import { checkAbort } from "./limits";
import { reconcileOcr } from "./ocrConsensus";
import { ocrSpans } from "./ocrGeometry";
import { detectTables } from "./tables";

export function preferLineText(
  before: readonly TextSpan[],
  after: readonly TextSpan[]
): boolean {
  const text = (spans: readonly TextSpan[]) =>
    spans
      .map((s) => s.text)
      .join("")
      .replace(/\s/gu, "");
  const a = Array.from(text(before)),
    b = Array.from(text(after));
  const confidence = (spans: readonly TextSpan[]) =>
    spans.reduce((sum, s) => sum + (s.confidence ?? 0) * s.text.length, 0) /
    Math.max(
      1,
      spans.reduce((sum, s) => sum + s.text.length, 0)
    );
  if (
    !a.length ||
    b.length < a.length * 0.8 ||
    b.length > a.length * 1.2 ||
    a.length > 400 ||
    b.length > 400 ||
    confidence(after) < Math.max(80, confidence(before) + 3)
  )
    return false;
  // A short line can contain several wrong glyphs. Bigram agreement rejects
  // the correct retry in that case, because one changed glyph breaks two pairs.
  // Use bounded character alignment, with separate guards for clear numbers.
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + Number(a[i - 1] !== b[j - 1])
      );
    row = next;
  }
  if (row[b.length] > Math.max(a.length, b.length) * 0.3) return false;
  const candidate = b.join("");
  return !before.some(
    (span) =>
      (span.confidence ?? 0) >= 85 &&
      /\d/u.test(span.text) &&
      !candidate.includes(span.text.replace(/\s/gu, ""))
  );
}

export async function refineScanLines(
  worker: Worker,
  canvas: HTMLCanvasElement,
  scale: number,
  page: RawPage,
  signal?: AbortSignal,
  textInput?: ImageData
): Promise<void> {
  const { used } = detectTables(
    page.rules,
    page.spans,
    median(page.spans.map((s) => s.size)) || 12
  );
  const lines = new Map<string, TextSpan[]>();
  for (const span of page.spans) {
    if (used.has(span.id)) continue;
    const key = span.lineId ?? span.id;
    lines.set(key, [...(lines.get(key) ?? []), span]);
  }
  const candidates = [...lines.values()]
    .map((spans) => ({
      spans,
      text: spans.map((s) => s.text).join(""),
      confidence:
        spans.reduce((sum, s) => sum + (s.confidence ?? 0) * s.text.length, 0) /
        Math.max(
          1,
          spans.reduce((sum, s) => sum + s.text.length, 0)
        ),
      box: bounds(spans),
    }))
    .filter(
      (line) =>
        line.confidence < 88 &&
        line.text.length >= 6 &&
        line.box.width >= line.box.height * 4
    )
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 20);
  if (!candidates.length) return;
  const crop = document.createElement("canvas");
  const deadline = Date.now() + 8_000;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    for (const [index, line] of candidates.entries()) {
      if (Date.now() > deadline) break;
      checkAbort(signal);
      const x = Math.max(0, Math.floor((line.box.x - 2) * scale)),
        y = Math.max(0, Math.floor((line.box.y - 2) * scale)),
        width = Math.min(
          canvas.width - x,
          Math.ceil((line.box.width + 4) * scale)
        ),
        height = Math.min(
          canvas.height - y,
          Math.ceil((line.box.height + 4) * scale)
        ),
        padding = Math.ceil(scale * 5);
      if (width <= 0 || height <= 0) continue;
      crop.width = width + padding * 2;
      crop.height = height + padding * 2;
      const ctx = crop.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, crop.width, crop.height);
      // Read intact glyphs. Removing a detected rule can also remove a stroke
      // from adjacent text, particularly on warped scans with gray borders.
      if (textInput)
        ctx.putImageData(
          textInput,
          padding - x,
          padding - y,
          x,
          y,
          width,
          height
        );
      else
        ctx.drawImage(
          canvas,
          x,
          y,
          width,
          height,
          padding,
          padding,
          width,
          height
        );
      const { data } = await worker.recognize(
        crop,
        {},
        { blocks: true, text: true }
      );
      checkAbort(signal);
      const after = reconcileOcr(
        line.spans,
        ocrSpans(data.blocks ?? [], scale, page.number).map((span) => ({
          ...span,
          id: `${span.id}:retry:${index}`,
          lineId: line.spans[0].lineId,
          blockId: line.spans[0].blockId,
          paragraphId: line.spans[0].paragraphId,
          x: span.x + (x - padding) / scale,
          y: Math.max(line.box.y, span.y + (y - padding) / scale),
          height: Math.min(span.height, line.box.height),
          size: Math.min(
            span.size,
            median(line.spans.map((s) => s.size)) * 1.1
          ),
          // A local text retry does not redefine the source reading row.
          // OCR may otherwise attach a right-edge word to the preceding row.
          baseline: median(line.spans.map((s) => s.baseline)),
        }))
      );
      if (!preferLineText(line.spans, after)) continue;
      const replaced = new Set(line.spans.map((s) => s.id));
      page.spans = page.spans.filter((s) => !replaced.has(s.id)).concat(after);
    }
  } finally {
    crop.width = crop.height = 0;
    if (!signal?.aborted)
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  }
}
