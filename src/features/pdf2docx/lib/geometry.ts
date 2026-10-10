import type { Box, Rule } from "../types";

export const right = (box: Box) => box.x + box.width;
export const bottom = (box: Box) => box.y + box.height;
export function median(values: readonly number[], fallback = 12): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function bounds(boxes: readonly Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x = Infinity,
    y = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const box of boxes) {
    x = Math.min(x, box.x);
    y = Math.min(y, box.y);
    maxX = Math.max(maxX, right(box));
    maxY = Math.max(maxY, bottom(box));
  }
  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y,
  };
}
export function containsCenter(outer: Box, inner: Box, tolerance = 0): boolean {
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return (
    x >= outer.x - tolerance &&
    x <= right(outer) + tolerance &&
    y >= outer.y - tolerance &&
    y <= bottom(outer) + tolerance
  );
}
export function uniquePositions(values: number[], tolerance = 2): number[] {
  const result: number[] = [];
  for (const value of values.sort((a, b) => a - b)) {
    if (!result.length || value - result[result.length - 1] > tolerance)
      result.push(value);
  }
  return result;
}
export function horizontal(rule: Rule): boolean {
  return Math.abs(rule.y1 - rule.y2) < 1.5;
}
export function vertical(rule: Rule): boolean {
  return Math.abs(rule.x1 - rule.x2) < 1.5;
}
