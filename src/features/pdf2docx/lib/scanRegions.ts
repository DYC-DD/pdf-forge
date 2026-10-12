import type { Box, RawPage, TextSpan } from "../types";
import { bottom, bounds, containsCenter, median, right } from "./geometry";
import { checkAbort } from "./limits";
import { buildLines } from "./paragraphs";
import { detectTables } from "./tables";

function uncertain(spans: readonly TextSpan[]): boolean {
  const letters = (s: TextSpan) =>
    Array.from(s.text.replace(/\s/gu, "")).length;
  const count = spans.reduce((sum, s) => sum + letters(s), 0);
  const score = spans.reduce(
    (sum, s) => sum + letters(s) * (s.confidence ?? 0),
    0
  );
  const low = spans.reduce(
    (sum, s) => sum + ((s.confidence ?? 0) < 60 ? letters(s) : 0),
    0
  );
  return (
    !count ||
    score / count < 84 ||
    low / count > 0.1 ||
    spans.some((s) => (s.confidence ?? 0) < 40 && /[\p{L}\p{N}]/u.test(s.text))
  );
}

function underlinedNumber(
  image: ImageData,
  scale: number,
  span: TextSpan
): boolean {
  if (!/\d/u.test(span.text) || span.width < 3) return false;
  // The stroke must extend beyond the glyph: the flat base of a 2 is not an underline.
  const left = Math.max(0, Math.floor((span.x - 2) * scale)),
    end = Math.min(image.width, Math.ceil((right(span) + 2) * scale));
  const top = Math.max(0, Math.floor((span.y + span.height - 2) * scale));
  const last = Math.min(
    image.height,
    Math.ceil((span.y + span.height + 3) * scale)
  );
  for (let y = top; y < last; y++) {
    let dark = 0;
    for (let x = left; x < end; x++) {
      const i = (y * image.width + x) * 4;
      if (Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) < 190)
        dark++;
    }
    if (dark > (end - left) * 0.8) return true;
  }
  return false;
}

const overlaps = (a: Box, b: Box) =>
  Math.min(right(a), right(b)) > Math.max(a.x, b.x) &&
  Math.min(bottom(a), bottom(b)) > Math.max(a.y, b.y);

/** Preserve an uncertain region exactly, without turning the surrounding
 * readable page into an image. Fonts are deliberately not an eligibility gate.
 */
export async function retainScanRegions(
  original: ImageData,
  scale: number,
  page: RawPage,
  artwork: readonly Box[],
  signal?: AbortSignal
): Promise<Box[]> {
  const lines = buildLines(
    page.spans.filter((s) => !s.rasterized),
    true
  );
  const { tables, used } = detectTables(
    page.rules,
    page.spans,
    median(page.spans.map((s) => s.size)) || 12,
    [],
    true
  );
  const body = lines.filter((line) => !line.spans.some((s) => used.has(s.id)));
  const regions: Box[] = [];
  // A watermark crossing a row invalidates that row even when the OCR model
  // gives a high score to a wrong amount. Include the complete writing row.
  for (const art of artwork) {
    let extent = art;
    // A two-tone watermark often has a gray emblem below its colored roof.
    // Include that connected visual neighborhood when it has substantial gray
    // ink, so preserving the overlap cannot cut the logo in half.
    if (art.width > 80 && art.height > 50) {
      let last = bottom(art);
      const x0 = Math.floor(art.x * scale),
        x1 = Math.min(original.width, Math.ceil(right(art) * scale));
      for (
        let y = Math.ceil(bottom(art) * scale);
        y < Math.min(original.height, (bottom(art) + art.height * 0.8) * scale);
        y += 2
      ) {
        let gray = 0,
          dark = 0;
        const textAtY = page.spans.filter(
          (s) => y / scale >= s.y - 1 && y / scale <= bottom(s) + 1
        );
        for (let x = x0; x < x1; x += 2) {
          const i = (y * original.width + x) * 4;
          const lo = Math.min(
            original.data[i],
            original.data[i + 1],
            original.data[i + 2]
          );
          const hi = Math.max(
            original.data[i],
            original.data[i + 1],
            original.data[i + 2]
          );
          if (
            lo > 95 &&
            hi < 245 &&
            hi - lo < 25 &&
            !textAtY.some(
              (s) => x / scale >= s.x - 1 && x / scale <= right(s) + 1
            )
          )
            gray++;
          if (hi < 95) dark++;
        }
        if (
          gray > (x1 - x0) * 0.05 &&
          gray < (x1 - x0) * 0.35 &&
          gray > dark * 3
        )
          last = y / scale;
      }
      extent = { ...art, height: last - art.y };
    }
    const crossing = body.filter((line) => overlaps(line, extent));
    if (crossing.length) regions.push(bounds([extent, ...crossing]));
  }
  for (const table of tables) {
    const content = page.spans.filter((s) => containsCenter(table, s));
    if (uncertain(content) || artwork.some((art) => overlaps(art, table)))
      regions.push(table);
  }
  for (const line of body) {
    if (
      uncertain(line.spans) ||
      line.spans.some((s) => underlinedNumber(original, scale, s))
    )
      regions.push(line);
  }
  if (!regions.length) return [];

  // Image rows and editable rows must not coexist in the same vertical band:
  // otherwise a side-by-side form field would create a second flowing row.
  // Include adjacent ink boxes only when their centers belong to the band.
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < regions.length; i++) {
      const box = regions[i];
      const neighbors: Box[] = [
        ...body.filter(
          (line) =>
            line.y + line.height / 2 > box.y &&
            line.y + line.height / 2 < bottom(box)
        ),
        ...tables.filter((table) => overlaps(table, box)),
      ];
      regions[i] = bounds([box, ...neighbors]);
    }
    regions.sort((a, b) => a.y - b.y);
    for (let i = regions.length - 1; i > 0; i--) {
      if (regions[i].y <= bottom(regions[i - 1]) + 3) {
        regions[i - 1] = bounds([regions[i - 1], regions[i]]);
        regions.splice(i, 1);
      }
    }
  }
  const retained: Box[] = [];
  for (const [index, region] of regions.entries()) {
    checkAbort(signal);
    const box = {
      x: Math.max(0, region.x - 2),
      y: Math.max(0, region.y - 1),
      width:
        Math.min(page.width, right(region) + 2) - Math.max(0, region.x - 2),
      height:
        Math.min(page.height, bottom(region) + 1) - Math.max(0, region.y - 1),
    };
    const x = Math.floor(box.x * scale),
      y = Math.floor(box.y * scale);
    const crop = document.createElement("canvas");
    crop.width = Math.min(original.width - x, Math.ceil(box.width * scale));
    crop.height = Math.min(original.height - y, Math.ceil(box.height * scale));
    try {
      crop
        .getContext("2d")!
        .putImageData(original, -x, -y, x, y, crop.width, crop.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        crop.toBlob(resolve, "image/png")
      );
      if (!blob) throw new Error("無法保留難辨識的原稿區塊。");
      checkAbort(signal);
      page.figures.push({
        ...box,
        id: `${page.number}:scan-region:${index}`,
        data: new Uint8Array(await blob.arrayBuffer()),
        role: "scan-region",
      });
      page.spans
        .filter((s) => containsCenter(box, s))
        .forEach((s) => {
          s.rasterized = true;
        });
      page.rules = page.rules.filter(
        (r) =>
          !containsCenter(box, {
            x: Math.min(r.x1, r.x2),
            y: Math.min(r.y1, r.y2),
            width: Math.abs(r.x2 - r.x1),
            height: Math.abs(r.y2 - r.y1),
          })
      );
      retained.push(box);
    } finally {
      crop.width = crop.height = 0;
    }
  }
  page.issues.push({
    page: page.number,
    code: "scan-regions",
    severity: "review",
    message: `有 ${retained.length} 個浮水印重疊或辨識不確定的區塊保留原圖；這些區塊無法直接編輯，其餘文字與表格可編輯。`,
  });
  return retained;
}
