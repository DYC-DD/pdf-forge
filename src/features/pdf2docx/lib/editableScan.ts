import type { Box, RawPage, TextSpan } from "../types";
import { bottom, containsCenter, median, right } from "./geometry";
import { checkAbort } from "./limits";
import { retainUncertainScan } from "./scanFallback";
import { createScanFontMatcher } from "./scanFont";
import { retainScanGraphics } from "./scanGraphics";
import { retainScanRegions } from "./scanRegions";

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
const colored = (data: Uint8ClampedArray, index: number) =>
  Math.max(data[index], data[index + 1], data[index + 2]) -
    Math.min(data[index], data[index + 1], data[index + 2]) >
    40 && Math.min(data[index], data[index + 1], data[index + 2]) < 220;

/** Isolate colored stamps/watermarks independently of recognized body text.
 * Ordinary colored text stays editable; only tall connected artwork is kept.
 */
export function scanColorRegions(
  image: Pixels,
  scale: number,
  spans: readonly TextSpan[]
): Box[] {
  const step = Math.max(2, Math.round(scale * 3));
  const width = Math.ceil(image.width / step),
    height = Math.ceil(image.height / step);
  const occupied = new Uint8Array(width * height);
  const textHeight = median(spans.map((span) => span.height)) || 12;
  for (let y = Math.ceil(image.height * 0.02); y < image.height * 0.98; y += 2)
    for (
      let x = Math.ceil(image.width * 0.02);
      x < image.width * 0.98;
      x += 2
    ) {
      if (!colored(image.data, (y * image.width + x) * 4)) continue;
      const cx = Math.floor(x / step),
        cy = Math.floor(y / step);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (
            cx + dx >= 0 &&
            cx + dx < width &&
            cy + dy >= 0 &&
            cy + dy < height
          )
            occupied[(cy + dy) * width + cx + dx] = 1;
    }
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
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
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
      x: Math.max(0, ((x0 + 1) * step) / scale - 1),
      y: Math.max(0, ((y0 + 1) * step) / scale - 1),
      width: ((x1 - x0 - 1) * step) / scale + 2,
      height: ((y1 - y0 - 1) * step) / scale + 2,
    };
    if (box.width >= 20 && box.height >= Math.max(25, textHeight * 2.3)) {
      // Logos and stamps have a small color palette. Photographs need all
      // their pixels, including grayscale detail, so leave those to graphics.
      const palette = new Map<number, number>();
      let count = 0;
      for (
        let y = Math.floor(box.y * scale);
        y < Math.min(image.height, bottom(box) * scale);
        y += 3
      )
        for (
          let x = Math.floor(box.x * scale);
          x < Math.min(image.width, right(box) * scale);
          x += 3
        ) {
          const i = (y * image.width + x) * 4;
          if (!colored(image.data, i)) continue;
          const key =
            (image.data[i] >> 5) * 64 +
            (image.data[i + 1] >> 5) * 8 +
            (image.data[i + 2] >> 5);
          palette.set(key, (palette.get(key) ?? 0) + 1);
          count++;
        }
      const dominant = [...palette.values()]
        .sort((a, b) => b - a)
        .slice(0, 8)
        .reduce((a, b) => a + b, 0);
      if (count && dominant / count >= 0.75) regions.push(box);
    }
    if (regions.length >= 24) break;
  }
  return regions;
}

function textInk(image: Pixels, scale: number, span: TextSpan) {
  const samples: number[][] = [[], [], []];
  let dark = 0,
    color = 0;
  for (
    let y = Math.max(0, Math.floor(span.y * scale));
    y < Math.min(image.height, Math.ceil(bottom(span) * scale));
    y += 2
  )
    for (
      let x = Math.max(0, Math.floor(span.x * scale));
      x < Math.min(image.width, Math.ceil(right(span) * scale));
      x += 2
    ) {
      const i = (y * image.width + x) * 4;
      if (colored(image.data, i)) {
        color++;
        for (let c = 0; c < 3; c++) samples[c].push(image.data[i + c]);
      } else if (
        Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) < 170
      )
        dark++;
    }
  return {
    dark,
    color,
    colorHex: samples
      .map((values) => Math.round(median(values)).toString(16).padStart(2, "0"))
      .join(""),
  };
}

export async function retainEditableScan(
  canvas: HTMLCanvasElement,
  original: ImageData,
  scale: number,
  page: RawPage,
  signal?: AbortSignal
): Promise<void> {
  // A completely unreadable page still needs a visible result, with an explicit
  // warning. A missing font never forces readable content into an image.
  if (!page.spans.some((span) => /[\p{L}\p{N}]/u.test(span.text))) {
    await retainUncertainScan(canvas, original, scale, page, signal);
    return;
  }
  const colorRegions = scanColorRegions(original, scale, page.spans);
  for (const span of page.spans) {
    const ink = textInk(original, scale, span);
    if (ink.color <= 3 || ink.color / Math.max(1, ink.color + ink.dark) < 0.85)
      continue;
    const area = (span.width * span.height * scale * scale) / 4;
    if (ink.dark >= Math.max(2, area * 0.02)) continue;
    if (colorRegions.some((box) => containsCenter(box, span))) {
      // Pure colored stamp lettering belongs to the stamp. Body text crossing
      // it is assessed with the complete overlap region below.
      span.rasterized = true;
    } else if (
      parseInt(ink.colorHex.slice(0, 2), 16) +
        parseInt(ink.colorHex.slice(2, 4), 16) +
        parseInt(ink.colorHex.slice(4, 6), 16) <
      540
    )
      span.color = ink.colorHex;
  }
  const retained = await retainScanRegions(
    original,
    scale,
    page,
    colorRegions,
    signal
  );
  const fontCandidates = page.spans.filter(
    (span) =>
      !span.rasterized &&
      (span.confidence ?? 0) >= 85 &&
      /\p{Script=Han}/u.test(span.text) &&
      span.text.length <= 8
  );
  const samples = fontCandidates
    .filter(
      (_, index) =>
        index % Math.max(1, Math.ceil(fontCandidates.length / 48)) === 0
    )
    .slice(0, 48);
  if (samples.length >= 8) {
    // Font similarity chooses a substitute; it is never permission to edit.
    const font = createScanFontMatcher(original, scale, false)(samples);
    if (font)
      page.spans.forEach((span) => {
        span.font = font;
      });
  }
  await retainScanGraphics(canvas, original, scale, page, signal, [
    ...colorRegions,
    ...retained,
  ]);
  const context = canvas.getContext("2d");
  if (!context) return;
  for (const [index, box] of colorRegions.entries()) {
    // Large photos/diagrams already preserved by the residual-ink detector.
    if (
      page.figures.some(
        (figure) =>
          containsCenter(figure, box) &&
          figure.width >= box.width &&
          figure.height >= box.height
      )
    )
      continue;
    checkAbort(signal);
    const x = Math.max(0, Math.floor(box.x * scale)),
      y = Math.max(0, Math.floor(box.y * scale));
    const crop = document.createElement("canvas");
    crop.width = Math.min(original.width - x, Math.ceil(box.width * scale));
    crop.height = Math.min(original.height - y, Math.ceil(box.height * scale));
    try {
      const ctx = crop.getContext("2d")!;
      const pixels = ctx.createImageData(crop.width, crop.height);
      for (let cy = 0; cy < crop.height; cy++)
        for (let cx = 0; cx < crop.width; cx++) {
          const source = ((y + cy) * original.width + x + cx) * 4,
            target = (cy * crop.width + cx) * 4;
          if (!colored(original.data, source)) continue;
          pixels.data.set(original.data.subarray(source, source + 3), target);
          pixels.data[target + 3] = 255;
        }
      ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        crop.toBlob(resolve, "image/png")
      );
      if (!blob) throw new Error("無法保留掃描圖章。");
      checkAbort(signal);
      page.figures.push({
        ...box,
        id: `${page.number}:scan-color:${index}`,
        data: new Uint8Array(await blob.arrayBuffer()),
        overlay: true,
        behindText: true,
      });
    } finally {
      crop.width = crop.height = 0;
    }
  }
  const editable = page.spans
    .filter((span) => !span.rasterized)
    .reduce((sum, span) => sum + span.text.replace(/\s/gu, "").length, 0);
  page.issues.push({
    page: page.number,
    code: "scan-editable",
    severity: "info",
    message: `已重建 ${editable} 個可編輯字元；圖形與難辨識區塊分開保留為原圖。可編輯文字仍請核對原稿。`,
  });
}
