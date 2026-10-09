import type {
  ImageConversionOptions,
  ImageConversionResult,
} from "./convertImages";
import type {
  ImageWorkerRequest,
  ImageWorkerResponse,
} from "./imageConversion.worker";
import type { ImageInput } from "./imageSource";

export function runImageConversion(
  inputs: ImageInput[],
  options: ImageConversionOptions
): Promise<ImageConversionResult> {
  const { signal, onProgress, onPackingProgress } = options;
  const cancelled = () => new DOMException("已取消轉換。", "AbortError");
  if (signal?.aborted) return Promise.reject(cancelled());
  // Older browsers can still use the HTML canvas decoder on the main thread.
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  )
    return import("./convertImages").then(({ convertImages }) =>
      convertImages(inputs, options)
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./imageConversion.worker.ts", import.meta.url),
      { type: "module" }
    );
    let settled = false;
    const finish = (result: ImageConversionResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timeout = setTimeout(
      () => finish(new Error("圖片轉換超過 2 分鐘，請分批處理較少圖片。")),
      120_000
    );
    const abort = () => finish(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<ImageWorkerResponse>) => {
      if (settled) return;
      const message = event.data;
      if (message.type === "progress") onProgress?.(message.done);
      else if (message.type === "packing") onPackingProgress?.(message.percent);
      else if (message.type === "error") finish(new Error(message.message));
      else finish(message.result);
    };
    worker.onerror = () => finish(new Error("圖片處理程序發生錯誤，請重試。"));
    worker.onmessageerror = () => finish(new Error("無法讀取圖片轉換結果。"));
    if (signal?.aborted) {
      abort();
      return;
    }
    const request: ImageWorkerRequest = {
      inputs,
      options: { format: options.format, outputName: options.outputName },
    };
    try {
      worker.postMessage(request);
    } catch {
      finish(new Error("無法啟動圖片處理程序。"));
    }
  });
}
