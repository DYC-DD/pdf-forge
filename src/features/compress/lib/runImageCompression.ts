import { COMPRESSION_LIMITS } from "../../../shared/pdf/limits";
import type { CompressionMode } from "../types";
import type { ImageCompressionResult } from "./compressImage";
import type {
  ImageCompressionWorkerRequest,
  ImageCompressionWorkerResponse,
} from "./compressImage.worker";

export function runImageCompression(
  file: File,
  mode: CompressionMode,
  signal?: AbortSignal
): Promise<ImageCompressionResult> {
  const cancelled = () => new DOMException("已取消壓縮。", "AbortError");
  if (signal?.aborted) return Promise.reject(cancelled());
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  )
    return import("./compressImage").then(({ compressImage }) =>
      compressImage(file, mode, signal)
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./compressImage.worker.ts", import.meta.url),
      { type: "module" }
    );
    let settled = false;
    const finish = (result: ImageCompressionResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error("圖片壓縮超過 2 分鐘，已停止處理；請改用低壓縮後重試。")
        ),
      COMPRESSION_LIMITS.timeoutMs
    );
    const abort = () => finish(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<ImageCompressionWorkerResponse>
    ) => {
      if (event.data.type === "error") finish(new Error(event.data.message));
      else finish(event.data.result);
    };
    worker.onerror = () => finish(new Error("圖片壓縮程序發生錯誤，請重試。"));
    worker.onmessageerror = () => finish(new Error("無法讀取圖片壓縮結果。"));
    if (signal?.aborted) {
      abort();
      return;
    }
    const request: ImageCompressionWorkerRequest = { file, mode };
    try {
      worker.postMessage(request);
    } catch {
      finish(new Error("無法啟動圖片壓縮程序。"));
    }
  });
}
