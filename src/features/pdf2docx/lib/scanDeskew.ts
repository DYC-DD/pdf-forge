type Pixels = { data: Uint8ClampedArray; width: number; height: number };

/** Estimate small scanner tilt from horizontal ink projection. Ignore the
 * paper edge; require a clear peak so photos and sparse pages stay unchanged.
 */
export function scanSkew(image: Pixels): number {
  const step = Math.max(1, Math.ceil(image.width / 700));
  const width = Math.ceil(image.width / step),
    height = Math.ceil(image.height / step);
  const points: [number, number][] = [];
  for (let y = Math.ceil(height * 0.05); y < height * 0.95; y++)
    for (let x = Math.ceil(width * 0.05); x < width * 0.95; x++) {
      const i = (y * step * image.width + x * step) * 4;
      if (image.data[i] + image.data[i + 1] + image.data[i + 2] < 480)
        points.push([x - width / 2, y]);
    }
  if (points.length < width * 3) return 0;
  const score = (angle: number) => {
    const rows = new Uint32Array(height);
    const slope = Math.tan((angle * Math.PI) / 180);
    for (const [x, y] of points) {
      const row = Math.round(y - x * slope);
      if (row >= 0 && row < height) rows[row]++;
    }
    return rows.reduce((sum, count) => sum + count * count, 0);
  };
  const base = score(0);
  let best = base,
    angle = 0;
  for (let i = -20; i <= 20; i++) {
    const candidate = i / 10,
      value = score(candidate);
    if (value > best) {
      best = value;
      angle = candidate;
    }
  }
  return Math.abs(angle) >= 0.2 && best > base * 1.12 ? angle : 0;
}

export function deskewScan(canvas: HTMLCanvasElement): number {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return 0;
  const angle = scanSkew(
    context.getImageData(0, 0, canvas.width, canvas.height)
  );
  if (!angle) return 0;
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  try {
    copy.getContext("2d")!.drawImage(canvas, 0, 0);
    context.save();
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((-angle * Math.PI) / 180);
    context.drawImage(copy, -canvas.width / 2, -canvas.height / 2);
    context.restore();
  } finally {
    copy.width = copy.height = 0;
  }
  return angle;
}
