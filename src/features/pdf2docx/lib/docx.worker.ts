import type { DocumentModel, ExportOptions, RawPage } from "../types";
import { analyzeLayout } from "./layout";

export type DocxWorkerRequest =
  | { kind: "analyze"; pages: RawPage[] }
  | { kind: "export"; model: DocumentModel; options: ExportOptions };
export type DocxWorkerResponse =
  | { kind: "analysis"; model: DocumentModel }
  | { kind: "export"; blob: Blob }
  | { kind: "error"; message: string };

self.onmessage = async (event: MessageEvent<DocxWorkerRequest>) => {
  try {
    const request = event.data;
    if (request.kind === "analyze")
      self.postMessage({
        kind: "analysis",
        model: analyzeLayout(request.pages),
      } satisfies DocxWorkerResponse);
    else {
      const { exportDocx } = await import("./exportDocx");
      self.postMessage({
        kind: "export",
        blob: await exportDocx(request.model, request.options),
      } satisfies DocxWorkerResponse);
    }
  } catch (error) {
    self.postMessage({
      kind: "error",
      message:
        error instanceof Error ? error.message : "文件處理失敗，請重新嘗試。",
    } satisfies DocxWorkerResponse);
  }
};
