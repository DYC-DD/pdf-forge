import type { TextSpan } from "../types";
import { createFontResolver } from "./fontMetrics";

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
type Ink = {
  pixels: Uint8Array;
  width: number;
  height: number;
  aspect: number;
};

// Compare silhouettes, not OCR confidence alone. A missing local font or a
// visibly different glyph must keep its original pixels in fidelity mode.
function ink(
  image: Pixels,
  x0 = 0,
  y0 = 0,
  x1 = image.width,
  y1 = image.height
): Ink | undefined {
  const dark = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    return image.data[i] + image.data[i + 1] + image.data[i + 2] < 555;
  };
  let left = x1,
    top = y1,
    right = x0,
    bottom = y0;
  for (
    let y = Math.max(0, Math.floor(y0));
    y < Math.min(image.height, Math.ceil(y1));
    y++
  )
    for (
      let x = Math.max(0, Math.floor(x0));
      x < Math.min(image.width, Math.ceil(x1));
      x++
    )
      if (dark(x, y)) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
  if (right <= left || bottom <= top) return;
  const aspect = (right - left) / (bottom - top);
  const height = 32,
    width = Math.max(2, Math.min(384, Math.round(height * aspect)));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels[y * width + x] = Number(
        dark(
          Math.min(
            right - 1,
            Math.floor(left + ((x + 0.5) * (right - left)) / width)
          ),
          Math.min(
            bottom - 1,
            Math.floor(top + ((y + 0.5) * (bottom - top)) / height)
          )
        )
      );
  return { pixels, width, height, aspect };
}

function difference(a: Ink, b: Ink): number {
  if (Math.abs(Math.log(a.aspect / b.aspect)) > 0.2) return 1;
  const missed = (first: Ink, second: Ink) => {
    let total = 0,
      absent = 0;
    for (let y = 0; y < first.height; y++)
      for (let x = 0; x < first.width; x++) {
        if (!first.pixels[y * first.width + x]) continue;
        total++;
        const sx = Math.round(
          (x * (second.width - 1)) / Math.max(1, first.width - 1)
        );
        let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (
              sx + dx >= 0 &&
              sx + dx < second.width &&
              y + dy >= 0 &&
              y + dy < second.height &&
              second.pixels[(y + dy) * second.width + sx + dx]
            ) {
              found = true;
              break;
            }
        if (!found) absent++;
      }
    return absent / Math.max(1, total);
  };
  return (missed(a, b) + missed(b, a)) / 2;
}

export function createScanFontMatcher(
  image: Pixels,
  scale: number,
  strict = true
) {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(1, 1)
      : typeof document !== "undefined"
        ? document.createElement("canvas")
        : undefined;
  const context = canvas?.getContext("2d") as
    CanvasRenderingContext2D | undefined;
  if (!canvas || !context) return () => undefined;
  const resolver = createFontResolver(context);
  const cache = new Map<string, Ink | undefined>();
  let inspected = 0;
  return (spans: TextSpan[]): string | undefined => {
    inspected += spans.length;
    // Dense or corrupt recognition must not allocate unbounded canvases.
    if (inspected > 3000 || spans.some((span) => span.text.length > 64)) return;
    const cjk = spans.some((span) => /\p{Script=Han}/u.test(span.text));
    const families = cjk
      ? ["DFKai-SB", "PMingLiU", "Noto Sans CJK TC"]
      : ["Arial", "Times New Roman"];
    const originals = spans.map((span) =>
      ink(
        image,
        span.x * scale,
        span.y * scale,
        (span.x + span.width) * scale,
        (span.y + span.height) * scale
      )
    );
    let best: { font: string; score: number } | undefined;
    for (const family of families) {
      const face = resolver.resolve(family);
      let score = 0,
        count = 0,
        valid = true;
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i],
          original = originals[i];
        if (!span.text.trim()) continue;
        if (!original || resolver.measure(span, face) === undefined) {
          if (!strict) continue;
          valid = false;
          break;
        }
        const font = /\p{Script=Han}/u.test(span.text)
          ? face.eastAsia
          : face.ascii;
        const key = `${font}:${span.text}`;
        if (!cache.has(key)) {
          context.font = `64px "${font}"`;
          const metrics = context.measureText(span.text);
          if (metrics.width > 3968) {
            if (!strict) continue;
            valid = false;
            break;
          }
          canvas.width = Math.max(1, Math.ceil(metrics.width + 128));
          canvas.height = 160;
          context.fillStyle = "white";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.font = `64px "${font}"`;
          context.fillStyle = "black";
          context.fillText(span.text, 64, 100);
          if (cache.size >= 512) cache.clear();
          cache.set(
            key,
            ink(context.getImageData(0, 0, canvas.width, canvas.height))
          );
        }
        const candidate = cache.get(key);
        const error = candidate ? difference(original, candidate) : 1;
        // OCR mistakes and watermark intersections are outliers when merely
        // choosing a substitute family, not grounds to reject editable text.
        if (!strict && error > 0.5) continue;
        // Reject even one very different word: high mean confidence can hide a
        // lost clause marker, a wrong number, or a decorative symbol.
        if (strict && error > 0.16) {
          valid = false;
          break;
        }
        const weight = Array.from(span.text).length;
        score += error * weight;
        count += weight;
      }
      if (
        valid &&
        count >= (strict ? 1 : 8) &&
        (!strict || score / count < 0.08) &&
        (!best || score / count < best.score)
      )
        best = { font: family, score: score / count };
    }
    return best?.font;
  };
}
