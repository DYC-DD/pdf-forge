import {
  convertImages,
  type ImageConversionOptions,
  type ImageConversionResult,
} from "./convertImages";
import type { ImageInput } from "./imageSource";

export type ImageWorkerRequest = {
  inputs: ImageInput[];
  options: Pick<ImageConversionOptions, "format" | "outputName">;
};
export type ImageWorkerResponse =
  | { type: "progress"; done: number }
  | { type: "packing"; percent: number }
  | { type: "result"; result: ImageConversionResult }
  | { type: "error"; message: string };

function send(message: ImageWorkerResponse) {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<ImageWorkerRequest>) => {
  try {
    const result = await convertImages(event.data.inputs, {
      ...event.data.options,
      onProgress: (done) => send({ type: "progress", done }),
      onPackingProgress: (percent) => send({ type: "packing", percent }),
    });
    send({ type: "result", result });
  } catch (error) {
    send({
      type: "error",
      message:
        error instanceof Error ? error.message : "圖片轉換失敗，請重試。",
    });
  }
};
