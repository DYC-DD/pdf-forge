import jpegDecodeWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?url";
import jpegEncodeWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url";
import webpEncodeWasm from "@jsquash/webp/codec/enc/webp_enc.wasm?url";

import { checkImageCancelled } from "./imageCanvas";

async function wasmBinary(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("無法載入圖片編碼器，請重新整理後再試。");
  return response.arrayBuffer();
}

let jpegDecoder:
  | Promise<import("@jsquash/jpeg/codec/dec/mozjpeg_dec.js").MozJPEGModule>
  | undefined;
let jpegEncoder:
  | Promise<import("@jsquash/jpeg/codec/enc/mozjpeg_enc.js").MozJPEGModule>
  | undefined;
let webpEncoder:
  Promise<import("@jsquash/webp/codec/enc/webp_enc.js").WebPModule> | undefined;

export async function decodeJpeg(bytes: Uint8Array, signal?: AbortSignal) {
  checkImageCancelled(signal);
  jpegDecoder ??= import("@jsquash/jpeg/codec/dec/mozjpeg_dec.js")
    .then(async ({ default: factory }) =>
      factory({ wasmBinary: await wasmBinary(jpegDecodeWasm) })
    )
    .catch((error) => {
      jpegDecoder = undefined;
      throw error;
    });
  const decoder = await jpegDecoder;
  checkImageCancelled(signal);
  const image = decoder.decode(new Uint8Array(bytes), false);
  if (!image) throw new Error("JPG 圖片無法解碼，請重新儲存後再試。");
  return image;
}

export async function encodeJpeg(
  image: ImageData,
  grayscale: boolean,
  signal?: AbortSignal,
  quality = 100
) {
  checkImageCancelled(signal);
  jpegEncoder ??= import("@jsquash/jpeg/codec/enc/mozjpeg_enc.js")
    .then(async ({ default: factory }) =>
      factory({ wasmBinary: await wasmBinary(jpegEncodeWasm) })
    )
    .catch((error) => {
      jpegEncoder = undefined;
      throw error;
    });
  const encoder = await jpegEncoder;
  const { defaultOptions } = await import("@jsquash/jpeg/meta.js");
  checkImageCancelled(signal);
  const result = encoder.encode(image.data, image.width, image.height, {
    ...defaultOptions,
    quality,
    color_space: grayscale ? 1 : 3,
    auto_subsample: false,
    chroma_subsample: 1,
    separate_chroma_quality: true,
    chroma_quality: quality,
    smoothing: 0,
  });
  if (!result?.length) throw new Error("JPG 編碼失敗，請分批處理較少圖片。");
  checkImageCancelled(signal);
  return new Uint8Array(result);
}

export async function encodeLosslessWebp(
  image: ImageData,
  signal?: AbortSignal
) {
  if (image.width > 16383 || image.height > 16383)
    throw new Error(
      "WEBP 單邊最多 16,383 像素；請改選 PNG、SVG 或 PDF，以保留原始解析度。"
    );
  checkImageCancelled(signal);
  webpEncoder ??= import("@jsquash/webp/codec/enc/webp_enc.js")
    .then(async ({ default: factory }) =>
      factory({ wasmBinary: await wasmBinary(webpEncodeWasm) })
    )
    .catch((error) => {
      webpEncoder = undefined;
      throw error;
    });
  const encoder = await webpEncoder;
  const { defaultOptions } = await import("@jsquash/webp/meta.js");
  checkImageCancelled(signal);
  const result = encoder.encode(image.data, image.width, image.height, {
    ...defaultOptions,
    lossless: 1,
    quality: 100,
    method: 6,
    exact: 1,
    near_lossless: 100,
    alpha_quality: 100,
  });
  if (
    !result?.length ||
    new TextDecoder().decode(result.subarray(12, 16)) !== "VP8L"
  )
    throw new Error("WEBP 無損編碼失敗，請改用 PNG 或分批處理較少圖片。");
  checkImageCancelled(signal);
  return new Uint8Array(result);
}
