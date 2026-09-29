import type { PageGroup, SplitOutput } from "../../features/split/types";

export type PdfOperationRequest =
  | { type: "merge"; files: File[] }
  | { type: "split"; file: File; groups: PageGroup[] };

export type PdfOperationResponse =
  | { type: "progress"; done: number }
  | { type: "packing"; percent: number }
  | { type: "merge-result"; blob: Blob }
  | { type: "split-result"; output: SplitOutput }
  | { type: "error"; message: string };

type Result = Extract<
  PdfOperationResponse,
  { type: "merge-result" | "split-result" }
>;

type Options = {
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
  onPackingProgress?: (percent: number) => void;
};

function abortError() {
  return new DOMException("處理已取消。", "AbortError");
}

function runPdfOperation(
  request: PdfOperationRequest,
  { signal, onProgress, onPackingProgress }: Options = {}
): Promise<Result> {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./pdfOperation.worker.ts", import.meta.url),
      {
        type: "module",
      }
    );
    let settled = false;

    function finish(result: Result | Error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    function onAbort() {
      finish(abortError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<PdfOperationResponse>) => {
      const response = event.data;
      if (settled) return;
      if (response.type === "progress") onProgress?.(response.done);
      else if (response.type === "packing")
        onPackingProgress?.(response.percent);
      else if (response.type === "error") finish(new Error(response.message));
      else finish(response);
    };
    worker.onerror = () => finish(new Error("PDF 處理程序發生錯誤，請重試。"));
    worker.onmessageerror = () => finish(new Error("無法讀取 PDF 處理結果。"));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage(request);
    } catch {
      finish(new Error("無法啟動 PDF 處理程序。"));
    }
  });
}

export async function runMergePdfs(
  files: File[],
  options?: Options
): Promise<Blob> {
  const result = await runPdfOperation({ type: "merge", files }, options);
  if (result.type !== "merge-result") throw new Error("合併結果格式不正確。");
  return result.blob;
}

export async function runSplitPdf(
  file: File,
  groups: PageGroup[],
  options?: Options
): Promise<SplitOutput> {
  const result = await runPdfOperation(
    { type: "split", file, groups },
    options
  );
  if (result.type !== "split-result") throw new Error("拆分結果格式不正確。");
  return result.output;
}
