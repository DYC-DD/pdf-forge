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

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./compressPdf.worker.ts", import.meta.url),
      {
        type: "module",
      }
    );
    let settled = false;

    function finish(
      result: { blob: Blob; appliedMode: CompressionMode } | Error
    ) {
      if (settled) return;
      settled = true;
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
