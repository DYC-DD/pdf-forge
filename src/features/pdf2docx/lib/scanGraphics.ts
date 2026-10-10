import type { Box, Rule, TextSpan } from "../types";
import { bottom, bounds, containsCenter, right } from "./geometry";
import { checkAbort } from "./limits";

// Work on a coarse occupancy grid, after masking OCR words and known rules.
// Large connected residuals with little text evidence are pictures/diagrams,
// rather than another paragraph. Keep their original pixels, including labels.
export function scanGraphics(
  image: Pick<ImageData, "data" | "width" | "height">,
  scale: number,
  spans: readonly TextSpan[],
  rules: readonly Rule[]
): Box[] {
  const step = Math.max(4, Math.round(4 * scale));
  const width = Math.ceil(image.width / step),
    height = Math.ceil(image.height / step);
  const mask = new Uint8Array(width * height),
    ink = new Uint16Array(width * height);
  const cover = (box: Box) => {
    const x0 = Math.max(0, Math.floor((box.x * scale) / step)),
      x1 = Math.min(width, Math.ceil((right(box) * scale) / step));
    const y0 = Math.max(0, Math.floor((box.y * scale) / step)),
      y1 = Math.min(height, Math.ceil((bottom(box) * scale) / step));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  };
  for (const span of spans)
    cover({
      x: span.x - 1,
      y: span.y - 1,
      width: span.width + 2,
      height: span.height + 2,
    });
  for (const rule of rules)
    cover({
      x: Math.min(rule.x1, rule.x2) - 1,
      y: Math.min(rule.y1, rule.y2) - 1,
      width: Math.abs(rule.x1 - rule.x2) + 2,
      height: Math.abs(rule.y1 - rule.y2) + 2,
    });
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const tile = Math.floor(y / step) * width + Math.floor(x / step);
      if (mask[tile]) continue;
      const i = (y * image.width + x) * 4;
      if (image.data[i] + image.data[i + 1] + image.data[i + 2] < 675)
        ink[tile]++;
    }
  const occupied = new Uint8Array(width * height);
  const threshold = Math.max(2, step * step * 0.015);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      if (ink[y * width + x] >= threshold)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            occupied[(y + dy) * width + x + dx] = 1;
  const regions: Box[] = [];
  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start]) continue;
    const queue = [start];
    occupied[start] = 0;
    let x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor],
        x = index % width,
        y = Math.floor(index / width);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nx = x + dx,
          ny = y + dy,
          next = ny * width + nx;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && occupied[next]) {
          occupied[next] = 0;
          queue.push(next);
        }
      }
    }
    const box = {
      x: Math.max(0, ((x0 + 1) * step) / scale - 2),
      y: Math.max(0, ((y0 + 1) * step) / scale - 2),
      width: Math.max(1, ((x1 - x0 - 1) * step) / scale + 4),
      height: Math.max(1, ((y1 - y0 - 1) * step) / scale + 4),
    };
    const area = box.width * box.height;
    if (
      box.width < 45 ||
      box.height < 30 ||
      area < ((image.width * image.height) / scale ** 2) * 0.004
    )
      continue;
    const text = spans.filter((span) => containsCenter(box, span));
    const textArea = text.reduce(
      (sum, span) => sum + span.width * span.height,
      0
    );
    if (textArea / area > 0.12 || text.some((span) => span.size > 20)) continue;
    // A line frame with editable text belongs to a form/table. Sparse diagonal
    // graphics and photographs retain substantially more residual ink.
    if (queue.length < 30) continue;
    regions.push(box);
    if (regions.length >= 24) break;
  }
  // A map page often has only a heading and page number. Pale roads disconnect
  // its ink components; retain the complete graphic, including its legend.
  if (
    spans.reduce((sum, span) => sum + span.text.length, 0) < 100 &&
    regions.some(
      (box) =>
        box.width > (image.width / scale) * 0.5 &&
        box.height > (image.height / scale) * 0.23
    )
  )
    return [bounds(regions)];
  // Small residual character clusters are not evidence of an illustration.
  return regions.filter(
    (box) =>
      box.width >= (image.width / scale) * 0.2 &&
      box.height >= (image.height / scale) * 0.1
  );
}

export async function retainScanGraphics(
  canvas: HTMLCanvasElement,
  image: ImageData,
  scale: number,
  page: import("../types").RawPage,
  signal?: AbortSignal
): Promise<void> {
  const context = canvas.getContext("2d");
  if (!context) return;
  const regions = scanGraphics(image, scale, page.spans, page.rules);
  if (!regions.length) return;
  context.putImageData(image, 0, 0);
  for (const [index, box] of regions.entries()) {
    checkAbort(signal);
    const crop = document.createElement("canvas");
    const x = Math.max(0, Math.floor(box.x * scale)),
      y = Math.max(0, Math.floor(box.y * scale));
    crop.width = Math.min(canvas.width - x, Math.ceil(box.width * scale));
    crop.height = Math.min(canvas.height - y, Math.ceil(box.height * scale));
    try {
      crop
        .getContext("2d")!
        .drawImage(
          canvas,
          x,
          y,
          crop.width,
          crop.height,
          0,
          0,
          crop.width,
          crop.height
        );
      const blob = await new Promise<Blob | null>((resolve) =>
        crop.toBlob(resolve, "image/png")
      );
      if (!blob) throw new Error("無法保留掃描圖片。");
      checkAbort(signal);
      page.figures.push({
        ...box,
        id: `${page.number}:scan:${index}`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
      page.spans
        .filter((span) => containsCenter(box, span))
        .forEach((span) => {
          span.rasterized = true;
        });
    } finally {
      crop.width = crop.height = 0;
    }
  }
  page.issues.push({
    page: page.number,
    code: "scan-graphics",
    severity: "review",
    message: "掃描圖形已按原位置保留；圖形內文字仍屬圖片，請核對圖像範圍。",
  });
}
