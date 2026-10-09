import { PDF_PREVIEW_LIMITS } from "./limits";

export function configurePreviewCanvas(
  canvas: HTMLCanvasElement,
  { width, height }: { width: number; height: number },
  devicePixelRatio = 1
): number[] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("PDF 頁面尺寸不正確，無法產生預覽。");
  }

  const pixelRatio = Number.isFinite(devicePixelRatio)
    ? Math.min(Math.max(devicePixelRatio, 1), 2)
    : 1;
  const scale = Math.min(
    pixelRatio,
    PDF_PREVIEW_LIMITS.canvasEdge / width,
    PDF_PREVIEW_LIMITS.canvasEdge / height,
    Math.sqrt(PDF_PREVIEW_LIMITS.canvasPixels / width / height)
  );
  let canvasWidth = Math.max(
    1,
    Math.min(PDF_PREVIEW_LIMITS.canvasEdge, Math.ceil(width * scale))
  );
  let canvasHeight = Math.max(
    1,
    Math.min(PDF_PREVIEW_LIMITS.canvasEdge, Math.ceil(height * scale))
  );
  // Rounding fractional dimensions up must not exceed the total pixel budget.
  if (canvasWidth * canvasHeight > PDF_PREVIEW_LIMITS.canvasPixels) {
    const correction = Math.sqrt(
      PDF_PREVIEW_LIMITS.canvasPixels / (canvasWidth * canvasHeight)
    );
    canvasWidth = Math.max(1, Math.floor(canvasWidth * correction));
    canvasHeight = Math.max(1, Math.floor(canvasHeight * correction));
  }

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  // Fit the complete page into the rounded bitmap; CSS preserves its layout.
  return [canvasWidth / width, 0, 0, canvasHeight / height, 0, 0];
}
