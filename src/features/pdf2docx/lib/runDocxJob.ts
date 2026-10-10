import type { DocumentModel, ExportOptions, RawPage } from "../types";
import type { DocxWorkerRequest, DocxWorkerResponse } from "./docx.worker";
import { checkAbort, DOCX_LIMITS } from "./limits";

async function runJob(
  request: DocxWorkerRequest,
  signal?: AbortSignal
): Promise<DocxWorkerResponse> {
  checkAbort(signal);
  if (typeof Worker === "undefined") {
    if (request.kind === "analyze")
      return {
        kind: "analysis",
        model: (await import("./layout")).analyzeLayout(request.pages),
      };
    return {
      kind: "export",
      blob: await (
        await import("./exportDocx")
      ).exportDocx(request.model, request.options),
    };
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./docx.worker.ts", import.meta.url), {
      type: "module",
    });
    let settled = false;
    const finish = (result: DocxWorkerResponse | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = () => finish(new DOMException("已取消處理。", "AbortError"));
    const timer = setTimeout(
      () => finish(new Error("文件處理超過 2 分鐘，請減少選取頁面。")),
      DOCX_LIMITS.workerTimeoutMs
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<DocxWorkerResponse>) =>
      finish(
        event.data.kind === "error" ? new Error(event.data.message) : event.data
      );
    worker.onerror = () => finish(new Error("文件背景處理程序發生錯誤。"));
    worker.onmessageerror = () => finish(new Error("無法讀取文件分析結果。"));
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage(request);
    } catch {
      finish(new Error("無法啟動文件背景處理。"));
    }
  });
}

export async function runLayoutAnalysis(
  pages: RawPage[],
  signal?: AbortSignal
): Promise<DocumentModel> {
  const result = await runJob({ kind: "analyze", pages }, signal);
  checkAbort(signal);
  if (result.kind !== "analysis") throw new Error("無法取得文件分析結果。");
  return result.model;
}
export async function runDocxExport(
  model: DocumentModel,
  options: ExportOptions,
  signal?: AbortSignal
): Promise<Blob> {
  const result = await runJob({ kind: "export", model, options }, signal);
  checkAbort(signal);
  if (result.kind !== "export") throw new Error("無法產生 Word 檔案。");
  return result.blob;
}
