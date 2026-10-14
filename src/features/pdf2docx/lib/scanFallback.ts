import type { RawPage, TextSpan } from "../types";
import { bottom, bounds, median, right } from "./geometry";
import { checkAbort } from "./limits";
import { buildLines } from "./paragraphs";
import { createScanFontMatcher } from "./scanFont";
import { scanParagraphs } from "./scanParagraphs";

/** Keep uncertain recognition and artwork as pixels; clear only reliable rows.
 * The retained layer is page anchored, so it cannot add height to Word's flow.
 * Confidence is a selection heuristic, never a claim of text correctness.
 */
export function editableScanLines(
  page: RawPage,
  image: { data: Uint8ClampedArray; width: number; height: number },
  scale: number
): TextSpan[][] {
  const lines = buildLines(
    page.spans.filter((span) => !span.rasterized),
    true
  );
  const size = median(lines.map((line) => line.size));
  return lines
    .filter((line) => {
      let weight = 0,
        confidence = 0,
        uncertain = 0;
      for (const span of line.spans) {
        const count = Array.from(span.text.trim()).length;
        weight += count;
        confidence += count * (span.confidence ?? 0);
        if ((span.confidence ?? 0) < 60) uncertain += count;
      }
      if (
        !weight ||
        confidence / weight < 88 ||
        uncertain / weight > 0.05 ||
        line.size < size * 0.65 ||
        line.size > size * 1.8 ||
        line.height > line.size * 1.6
      )
        return false;
      // A crop must never erase a neighboring row, grid, underline, or artwork.
      if (
        lines.some(
          (other) =>
            other !== line &&
            Math.min(bottom(line), bottom(other)) - Math.max(line.y, other.y) >
              Math.min(line.height, other.height) * 0.25
        )
      )
        return false;
      if (
        page.rules.some(
          (rule) =>
            Math.min(rule.y1, rule.y2) <= bottom(line) + 2 &&
            Math.max(rule.y1, rule.y2) >= line.y - 2 &&
            Math.min(rule.x1, rule.x2) <= right(line) + 2 &&
            Math.max(rule.x1, rule.x2) >= line.x - 2
        )
      )
        return false;
      const x0 = Math.max(0, Math.floor(line.x * scale)),
        y0 = Math.max(0, Math.floor(line.y * scale)),
        x1 = Math.min(image.width, Math.ceil(right(line) * scale)),
        y1 = Math.min(image.height, Math.ceil(bottom(line) * scale));
      let colored = 0,
        paper = 0,
        samples = 0;
      for (let y = y0; y < y1; y += 2)
        for (let x = x0; x < x1; x += 2) {
          const i = (y * image.width + x) * 4;
          const r = image.data[i],
            g = image.data[i + 1],
            b = image.data[i + 2];
          samples++;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 28) colored++;
          if (Math.min(r, g, b) > 215) paper++;
        }
      if (!samples || colored / samples >= 0.002 || paper / samples <= 0.6)
        return false;
      // Detect ink omitted by OCR (a clause marker or the last word). Never
      // erase a partial row and leave fragments beside replacement text.
      let ink = 0,
        unclaimed = 0;
      for (let y = y0; y < y1; y += 2)
        for (
          let x = Math.floor(image.width * 0.04);
          x < image.width * 0.96;
          x += 2
        ) {
          const i = (y * image.width + x) * 4;
          if (image.data[i] + image.data[i + 1] + image.data[i + 2] >= 480)
            continue;
          ink++;
          if (
            !line.spans.some(
              (span) => x >= span.x * scale - 3 && x <= right(span) * scale + 3
            )
          )
            unclaimed++;
        }
      return unclaimed <= Math.max(4, ink * 0.025);
    })
    .map((line) => line.spans);
}

export async function retainUncertainScan(
  canvas: HTMLCanvasElement,
  original: ImageData,
  scale: number,
  page: RawPage,
  signal?: AbortSignal
): Promise<void> {
  const context = canvas.getContext("2d");
  if (!context) return;
  const matchFont = createScanFontMatcher(original, scale);
  const candidates = editableScanLines(page, original, scale).filter(
    (spans) => {
      const font = matchFont(spans);
      if (!font) return false;
      spans.forEach((span) => {
        span.font = font;
      });
      return true;
    }
  );
  const candidateIds = new Set(candidates.flat().map((span) => span.id));
  // The background route must honor the same complete-paragraph decision as
  // local crops. A reliable line cannot revive part of a rejected paragraph.
  const editable = scanParagraphs(buildLines(page.spans, true), page.rules)
    .filter((paragraph) =>
      paragraph.lines.every((line) =>
        line.spans.every((span) => candidateIds.has(span.id))
      )
    )
    .flatMap((paragraph) => paragraph.lines.map((line) => line.spans));
  const ids = new Set(editable.flat().map((span) => span.id));
  context.putImageData(original, 0, 0);
  context.fillStyle = "#ffffff";
  for (const spans of editable) {
    // Clear contiguous text, including antialiasing around its word boxes.
    // Leave wide gaps between fields intact (signatures/checkboxes may live there).
    for (const line of buildLines(spans)) {
      const box = bounds(line.spans);
      context.fillRect(
        box.x * scale - 3,
        box.y * scale - 3,
        box.width * scale + 6,
        box.height * scale + 6
      );
    }
  }
  checkAbort(signal);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.96)
  );
  if (!blob) throw new Error("無法保留掃描原稿影像。");
  checkAbort(signal);
  page.spans.forEach((span) => {
    span.rasterized = !ids.has(span.id);
  });
  // Rules and uncertain cells already remain in the original image. Do not
  // draw a second grid or infer columns from fragmented recognition in it.
  page.rules = [];
  // The full original layer also contains previously retained local crops.
  page.figures = [];
  page.issues = page.issues.filter(
    (issue) =>
      ![
        "scan-regions",
        "scan-graphics",
        "scan-editable",
        "scan-fallback",
      ].includes(issue.code)
  );
  page.figures.push({
    id: `${page.number}:scan-background`,
    x: 0,
    y: 0,
    width: page.width,
    height: page.height,
    data: new Uint8Array(await blob.arrayBuffer()),
    format: "jpg",
    overlay: true,
    behindText: true,
    role: "scan-background",
  });
  page.issues.push({
    page: page.number,
    code: "scan-fallback",
    severity: "review",
    message: editable.length
      ? `已保留 ${editable.length} 行可編輯文字；其餘無法可靠重建的文字、表格與圖像保留原稿影像。可編輯文字仍需核對。`
      : "此頁未找到能可靠重建的文字行，已完整保留原稿影像；本頁文字無法直接編輯。",
  });
}
