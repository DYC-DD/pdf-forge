import { PSM, type Worker } from "tesseract.js";

import type { RawPage, TextSpan } from "../types";
import { containsCenter, median } from "./geometry";
import { checkAbort } from "./limits";
import { reconcileOcr } from "./ocrConsensus";
import { ocrSpans } from "./ocrGeometry";
import { detectTables } from "./tables";

export function preferCellText(
  before: readonly TextSpan[],
  after: readonly TextSpan[]
): boolean {
  const count = (spans: readonly TextSpan[]) =>
    spans.reduce((sum, s) => sum + s.text.replace(/\s/gu, "").length, 0);
  const confidence = (spans: readonly TextSpan[]) =>
    spans.reduce((sum, s) => sum + (s.confidence ?? 0) * s.text.length, 0) /
    Math.max(
      1,
      spans.reduce((sum, s) => sum + s.text.length, 0)
    );
  const a = count(before),
    b = count(after),
    previous = confidence(before),
    next = confidence(after);
  if (!b || next < (previous < 50 ? 65 : 75) || next < previous + 3)
    return false;
  // Avoid substituting a longer hallucinated result or silently dropping most
  // of a cell. Numeric cells require stronger evidence than ordinary labels.
  if (
    a &&
    (b > (previous < 65 ? Math.max(2, a * 2.5) : a * 1.6 + 2) ||
      (previous >= 65 && b < a * 0.5))
  )
    return false;
  if (before.every((s) => /^[\d\s.,/%之分]+$/u.test(s.text)) && a) {
    if (next < 90 || !after.every((s) => /^[\d\s.,/%之分]+$/u.test(s.text)))
      return false;
    const literal = (spans: readonly TextSpan[]) =>
      spans
        .map((s) => s.text)
        .join("")
        .replace(/\s/gu, "");
    if (previous >= 90 && literal(before) !== literal(after)) return false;
  }
  return true;
}

/** Re-read uncertain table cells with white context around the crop. Tight
 * crops and full-page grid segmentation both confuse small scanned glyphs.
 * Keep the first reading unless the independent pass has stronger evidence.
 */
export async function refineScanTables(
  worker: Worker,
  canvas: HTMLCanvasElement,
  original: ImageData,
  scale: number,
  page: RawPage,
  signal?: AbortSignal
): Promise<void> {
  const tables = detectTables(
    page.rules,
    page.spans,
    median(page.spans.map((s) => s.size)) || 12
  ).tables;
  if (!tables.length) return;
  const source = document.createElement("canvas");
  source.width = original.width;
  source.height = original.height;
  source.getContext("2d")!.putImageData(original, 0, 0);
  const crop = document.createElement("canvas");
  let inspected = 0;
  const deadline = Date.now() + 12_000;
  try {
    for (const table of tables)
      for (const cell of table.cells) {
        if (++inspected > 120 || Date.now() > deadline) return;
        checkAbort(signal);
        const box = {
          x:
            table.x +
            table.columns.slice(0, cell.column).reduce((a, b) => a + b, 0),
          y: table.y + table.rows.slice(0, cell.row).reduce((a, b) => a + b, 0),
          width: table.columns
            .slice(cell.column, cell.column + cell.columnSpan)
            .reduce((a, b) => a + b, 0),
          height: table.rows
            .slice(cell.row, cell.row + cell.rowSpan)
            .reduce((a, b) => a + b, 0),
        };
        const before = page.spans.filter((span) => containsCenter(box, span));
        if (!before.length) continue;
        const x = Math.max(0, (box.x + 1.5) * scale),
          y = Math.max(0, (box.y + 1) * scale),
          width = Math.min(
            canvas.width - x,
            Math.ceil((box.width - 3) * scale)
          ),
          height = Math.min(
            canvas.height - y,
            Math.ceil((box.height - 2) * scale)
          );
        if (width < 3 || height < 3) continue;
        const padding = Math.round(scale * 5);
        crop.width = width + padding * 2;
        crop.height = height + padding * 2;
        const ctx = crop.getContext("2d")!;
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, crop.width, crop.height);
        ctx.drawImage(
          source,
          x,
          y,
          width,
          height,
          padding,
          padding,
          width,
          height
        );
        // Curved scans leave a one-pixel border remnant even inside an inset
        // cell crop. It otherwise gets read as extra Latin letters or quotes.
        ctx.strokeStyle = "white";
        ctx.lineWidth = Math.max(2, scale);
        ctx.strokeRect(padding, padding, width, height);
        await worker.setParameters({
          tessedit_pageseg_mode:
            cell.rowSpan > 1 ? PSM.SINGLE_BLOCK : PSM.SINGLE_LINE,
        });
        let { data } = await worker.recognize(
          crop,
          {},
          { blocks: true, text: true }
        );
        checkAbort(signal);
        if (data.confidence < 80) {
          const pixels = ctx.getImageData(0, 0, crop.width, crop.height);
          // Gray paper texture can be read as extra characters. Compare a
          // cleaned local crop, keeping the original reading as an alternative.
          for (const cutoff of [190, 170]) {
            if (Date.now() > deadline || data.confidence >= 80) break;
            const cleaned = ctx.createImageData(crop.width, crop.height);
            for (let i = 0; i < pixels.data.length; i += 4) {
              const gray =
                (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 3;
              cleaned.data[i] =
                cleaned.data[i + 1] =
                cleaned.data[i + 2] =
                  gray < cutoff ? 0 : 255;
              cleaned.data[i + 3] = 255;
            }
            ctx.putImageData(cleaned, 0, 0);
            const retry = (
              await worker.recognize(crop, {}, { blocks: true, text: true })
            ).data;
            checkAbort(signal);
            if (retry.confidence > data.confidence) data = retry;
          }
        }
        const candidate = ocrSpans(data.blocks ?? [], scale, page.number)
          .map((span) => ({
            ...span,
            id: `${span.id}:cell:${inspected}`,
            lineId: `${span.lineId}:cell:${inspected}`,
            blockId: `${span.blockId}:cell:${inspected}`,
            paragraphId: `${span.paragraphId}:cell:${inspected}`,
            x: span.x + (x - padding) / scale,
            y: span.y + (y - padding) / scale,
            baseline: span.baseline + (y - padding) / scale,
          }))
          .filter((span) => containsCenter(box, span));
        const after = reconcileOcr(before, candidate);
        if (!preferCellText(before, after)) continue;
        const replaced = new Set(before.map((span) => span.id));
        page.spans = page.spans
          .filter((span) => !replaced.has(span.id))
          .concat(after);
      }
  } finally {
    crop.width = crop.height = source.width = source.height = 0;
    if (!signal?.aborted)
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  }
}
