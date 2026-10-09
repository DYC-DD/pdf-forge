import { displayedSize, type ImageInfo } from "./imageSource";

export function checkImageCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("已取消轉換。", "AbortError");
}

export async function decodeImage(file: File, signal?: AbortSignal) {
  checkImageCancelled(signal);
  if (typeof createImageBitmap === "function") {
    const image = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    if (signal?.aborted) {
      image.close();
      checkImageCancelled(signal);
    }
    return {
      image,
      width: image.width,
      height: image.height,
      close: () => image.close(),
    };
  }
  if (typeof Image === "undefined")
    throw new Error("目前的瀏覽器無法解碼圖片，請更新瀏覽器後重試。");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      const finish = (error?: Error) => {
        signal?.removeEventListener("abort", abort);
        element.onload = null;
        element.onerror = null;
        if (error) {
          element.src = "";
          reject(error);
        } else resolve(element);
      };
      const abort = () =>
        finish(new DOMException("已取消轉換。", "AbortError"));
      element.onload = () => finish();
      element.onerror = () =>
        finish(new Error("圖片無法解碼，請重新選擇檔案。"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else element.src = url;
    });
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => {
        image.src = "";
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function makeImageCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function canvasBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string
) {
  const blob =
    "convertToBlob" in canvas
      ? await canvas.convertToBlob({ type, quality: 1 })
      : await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, type, 1)
        );
  if (!blob || blob.type !== type)
    throw new Error(
      `目前的瀏覽器不支援 ${type === "image/webp" ? "WEBP" : "此格式"} 輸出，請選擇其他格式。`
    );
  return blob;
}

export async function rasterImage(
  file: File,
  info: ImageInfo,
  rotation: number,
  type: string,
  signal?: AbortSignal,
  maxEdge?: number
) {
  const decoded = await decodeImage(file, signal);
  let canvas: ReturnType<typeof makeImageCanvas> | undefined;
  try {
    const natural = displayedSize(info);
    if (decoded.width !== natural.width || decoded.height !== natural.height)
      throw new Error("圖片方向或尺寸無法正確辨識，請重新儲存圖片後重試。");
    const size = displayedSize(info, rotation);
    const scale = maxEdge
      ? Math.min(1, maxEdge / Math.max(size.width, size.height))
      : 1;
    canvas = makeImageCanvas(
      Math.max(1, Math.round(size.width * scale)),
      Math.max(1, Math.round(size.height * scale))
    );
    const context = canvas.getContext("2d") as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("無法建立圖片繪圖區域。");
    if (type === "image/jpeg") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.scale(scale, scale);
    if (rotation === 90) context.translate(size.width, 0);
    else if (rotation === 180) context.translate(size.width, size.height);
    else if (rotation === 270) context.translate(0, size.height);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(decoded.image, 0, 0);
    checkImageCancelled(signal);
    const blob = await canvasBlob(canvas, type);
    checkImageCancelled(signal);
    return blob;
  } finally {
    decoded.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
