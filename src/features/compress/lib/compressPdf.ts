import { COMPRESSION_LIMITS, pdfFileError } from "../../../shared/pdf/limits";
import type {
  CompressionMode,
  CompressionWorkerRequest,
  CompressionWorkerResponse,
} from "../types";

export function compressPdf(
  file: File,
  mode: CompressionMode,
  signal?: AbortSignal
): Promise<{ blob: Blob; appliedMode: CompressionMode }> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("壓縮已取消。", "AbortError"));
  }
  const error = pdfFileError(file);
  if (error) return Promise.reject(new Error(error));

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./compressPdf.worker.ts", import.meta.url),
      {
        type: "module",
      }
    );
    let settled = false;
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            "壓縮已超過 2 分鐘，已停止處理；請拆分檔案或改用低壓縮後重試。"
          )
        ),
      COMPRESSION_LIMITS.timeoutMs
    );

    function finish(
      result: { blob: Blob; appliedMode: CompressionMode } | Error
    ) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    function onAbort() {
      finish(new DOMException("壓縮已取消。", "AbortError"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<CompressionWorkerResponse>) => {
      if (event.data.type === "error") {
        finish(new Error(event.data.message));
        return;
      }
      finish({
        blob: new Blob([event.data.bytes], { type: "application/pdf" }),
        appliedMode: event.data.appliedMode,
      });
    };
    worker.onerror = () => finish(new Error("壓縮程序發生錯誤，請重試。"));
    worker.onmessageerror = () =>
      finish(new Error("無法接收壓縮結果，請重試。"));
    if (signal?.aborted) {
      onAbort();
      return;
    }

    file
      .arrayBuffer()
      .then((bytes) => {
        if (settled) return;
        const request: CompressionWorkerRequest = { bytes, mode };
        worker.postMessage(request, [bytes]);
      })
      .catch(() => finish(new Error("無法讀取這份 PDF。")));
  });
}
