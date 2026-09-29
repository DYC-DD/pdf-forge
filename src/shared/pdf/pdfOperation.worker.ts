import { mergePdfs } from "../../features/merge/lib/mergePdfs";
import { splitPdf } from "../../features/split/lib/splitPdf";
import type {
  PdfOperationRequest,
  PdfOperationResponse,
} from "./runPdfOperation";

function send(response: PdfOperationResponse) {
  self.postMessage(response);
}

self.onmessage = async (event: MessageEvent<PdfOperationRequest>) => {
  try {
    if (event.data.type === "merge") {
      const blob = await mergePdfs(event.data.files, (done) =>
        send({ type: "progress", done })
      );
      send({ type: "merge-result", blob });
      return;
    }

    const output = await splitPdf(
      event.data.file,
      event.data.groups,
      (done) => send({ type: "progress", done }),
      (percent) => send({ type: "packing", percent })
    );
    send({ type: "split-result", output });
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : "處理 PDF 時發生錯誤。",
    });
  }
};
