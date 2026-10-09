import type JSZip from "jszip";

export function packImageZip(
  zip: JSZip,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const stream = zip.generateInternalStream({
      type: "uint8array",
      compression: "STORE",
      streamFiles: true,
    });
    let chunks: BlobPart[] = [];
    let settled = false;
    const release = () => {
      settled = true;
      chunks = [];
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      stream.pause();
      release();
      reject(new DOMException("已取消轉換。", "AbortError"));
    };
    stream
      .on("data", (chunk, metadata) => {
        if (settled) return;
        chunks.push(new Uint8Array(chunk));
        onProgress?.(Math.floor(metadata.percent));
      })
      .on("error", (error) => {
        release();
        reject(error);
      })
      .on("end", () => {
        if (settled) return;
        const blob = new Blob(chunks, { type: "application/zip" });
        release();
        resolve(blob);
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else stream.resume();
  });
}
