import type { Box, RawPage } from "../types";

// Some scanner exports use pixel counts as PDF points, yielding metre-sized
// sheets. Keep the aspect ratio and all geometry together when fitting these
// oversized scans to a printable long edge. Ordinary A3/A4/native PDFs stay put.
export function normalizeOversizedScan(page: RawPage): void {
  if (page.source !== "ocr" || Math.max(page.width, page.height) <= 1584)
    return;
  const factor = (297 * 72) / 25.4 / Math.max(page.width, page.height);
  const box = (value: Box) => {
    value.x *= factor;
    value.y *= factor;
    value.width *= factor;
    value.height *= factor;
  };
  page.width *= factor;
  page.height *= factor;
  for (const span of page.spans) {
    box(span);
    span.size *= factor;
    span.baseline *= factor;
    if (span.advances)
      span.advances = span.advances.map((value) => value * factor);
  }
  for (const rule of page.rules) {
    rule.x1 *= factor;
    rule.x2 *= factor;
    rule.y1 *= factor;
    rule.y2 *= factor;
    if (rule.thickness) rule.thickness *= factor;
  }
  page.figures.forEach(box);
  page.fills?.forEach(box);
  page.issues.push({
    page: page.number,
    code: "scan-page-size",
    severity: "review",
    message:
      "掃描原稿的紙張尺寸過大，已等比例縮至長邊 29.7 公分；文字、圖片與位置同步縮放。",
  });
}
