import type { CompressionMode } from "../types";
import { compressImage, type ImageCompressionResult } from "./compressImage";

export type ImageCompressionWorkerRequest = {
  file: File;
  mode: CompressionMode;
};
export type ImageCompressionWorkerResponse =
  | { type: "result"; result: ImageCompressionResult }
  | { type: "error"; message: string };

self.onmessage = async (event: MessageEvent<ImageCompressionWorkerRequest>) => {
  try {
    const result = await compressImage(event.data.file, event.data.mode);
    self.postMessage({
      type: "result",
      result,
    } satisfies ImageCompressionWorkerResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      message:
        error instanceof Error ? error.message : "圖片壓縮失敗，請重試。",
    } satisfies ImageCompressionWorkerResponse);
  }
};
