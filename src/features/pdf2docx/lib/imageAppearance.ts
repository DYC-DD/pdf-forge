// A red stamp on a neutral white backdrop is a common signed-PDF annotation.
// Only infer it when it overlaps several native text spans; ordinary photos and
// standalone images retain their original alpha and backdrop.
export function transparentStamp(
  data: Uint8ClampedArray,
  inferStamp: boolean,
  multiply = false
): boolean {
  let white = 0,
    colored = 0,
    red = 0;
  const count = data.length / 4;
  if (!multiply && inferStamp) {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 240) continue;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      if (Math.min(r, g, b) > 240) white++;
      else if (Math.max(r, g, b) - Math.min(r, g, b) > 25) {
        colored++;
        if (r > 100 && r - g > 20 && r - b > 20) red++;
      }
    }
  }
  if (
    !multiply &&
    !(
      inferStamp &&
      white > count * 0.2 &&
      colored > count * 0.02 &&
      red > colored * 0.95
    )
  )
    return false;
  for (let i = 0; i < data.length; i += 4) {
    const neutral = Math.min(data[i], data[i + 1], data[i + 2]);
    const alpha = 255 - neutral;
    for (let c = 0; c < 3; c++)
      data[i + c] = alpha ? ((data[i + c] - neutral) * 255) / alpha : 0;
    data[i + 3] = Math.round((data[i + 3] * alpha) / 255);
  }
  return true;
}
