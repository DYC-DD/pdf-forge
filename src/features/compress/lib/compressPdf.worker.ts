import type {
  CompressionWorkerRequest,
  CompressionWorkerResponse,
} from "../types";
import { compressPdfWithDetails } from "./compressPdfBytes";

self.onmessage = async (event: MessageEvent<CompressionWorkerRequest>) => {
  try {
    const { bytes, appliedMode } = await compressPdfWithDetails(
      new Uint8Array(event.data.bytes),
      event.data.mode
    );
    const response: CompressionWorkerResponse = {
      type: "success",
      bytes: bytes.buffer as ArrayBuffer,
      appliedMode,
    };
    self.postMessage(response, { transfer: [response.bytes] });
  } catch (error) {
    const response: CompressionWorkerResponse = {
      type: "error",
      message: error instanceof Error ? error.message : "處理 PDF 時發生錯誤。",
    };
    self.postMessage(response);
  }
};
