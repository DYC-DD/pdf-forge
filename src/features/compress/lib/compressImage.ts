import { zlibSync } from "fflate";

import { checkImageCancelled } from "../../convert/lib/imageCanvas";
import { encodeJpeg } from "../../convert/lib/imageCodecs";
import {
  jpegSegments,
  jpegWithProfile,
  pngBytes,
  pngChunks,
} from "../../convert/lib/imageMetadata";
import {
  decodePixels,
  rgba8,
  transformPixels,
  type ImagePixels,
} from "../../convert/lib/imagePixels";
import {
  IMAGE_INPUT_LIMITS,
  inspectImageBytes,
} from "../../convert/lib/imageSource";
import type { CompressionMode } from "../types";

export const HIGH_IMAGE_MAX_EDGE = 1920;
export type ImageCompressionResult = {
  blob: Blob;
  appliedMode: CompressionMode;
};

function stripMetadata(bytes: Uint8Array, format: "jpg" | "png") {
  if (format === "png")
    return pngBytes(
      pngChunks(bytes).filter(
        ({ type }) => !["tEXt", "zTXt", "iTXt", "tIME"].includes(type)
      )
    );
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const { marker, data, start, end } of jpegSegments(bytes)) {
    const exif = new TextDecoder().decode(data.subarray(0, 6)) === "Exif\0\0";
    // Keep EXIF orientation, ICC, JFIF and Adobe color information intact.
    if (marker !== 0xfe && marker !== 0xed && !(marker === 0xe1 && !exif))
      continue;
    parts.push(bytes.subarray(at, start));
    at = end;
  }
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0) + bytes.length - at
  );
  let offset = 0;
  for (const part of [...parts, bytes.subarray(at)]) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function paeth(left: number, up: number, upperLeft: number) {
  const p = left + up - upperLeft;
  const a = Math.abs(p - left),
    b = Math.abs(p - up),
    c = Math.abs(p - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

function encodeOptimizedPng(image: ImagePixels, signal?: AbortSignal) {
  const bytesPerPixel = image.channels * (image.depth / 8);
  const stride = image.width * bytesPerPixel;
  const filtered = new Uint8Array((stride + 1) * image.height);
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < image.height; y++) {
    checkImageCancelled(signal);
    if (image.depth === 16) {
      const view = new DataView(row.buffer);
      for (let x = 0; x < image.width * image.channels; x++)
        view.setUint16(x * 2, image.data[y * image.width * image.channels + x]);
    } else row.set(image.data.subarray(y * stride, (y + 1) * stride));
    const offset = y * (stride + 1);
    let best = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
        const up = previous[x];
        const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : paeth(left, up, upperLeft);
        const value = (row[x] - predictor) & 255;
        candidate[x] = value;
        score += Math.min(value, 256 - value);
      }
      if (score < best) {
        best = score;
        filtered[offset] = filter;
        filtered.set(candidate, offset + 1);
      }
    }
    [previous, row] = [row, previous];
  }
  checkImageCancelled(signal);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header[8] = image.depth;
  header[9] = [0, 0, 4, 2, 6][image.channels];
  return pngBytes([
    { type: "IHDR", data: header },
    ...image.colorChunks,
    { type: "IDAT", data: zlibSync(filtered, { level: 9 }) },
    { type: "IEND", data: new Uint8Array() },
  ]);
}

function resizePixels(image: ImagePixels, signal?: AbortSignal): ImagePixels {
  const scale = Math.min(
    1,
    HIGH_IMAGE_MAX_EDGE / Math.max(image.width, image.height)
  );
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data =
    image.depth === 16
      ? new Uint16Array(width * height * image.channels)
      : new Uint8Array(width * height * image.channels);
  const hasAlpha = image.channels === 2 || image.channels === 4;
  const max = image.depth === 16 ? 65535 : 255;
  for (let y = 0; y < height; y++) {
    checkImageCancelled(signal);
    const sourceY = Math.max(0, ((y + 0.5) * image.height) / height - 0.5);
    const top = Math.floor(sourceY),
      bottom = Math.min(top + 1, image.height - 1);
    const fy = sourceY - top;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.max(0, ((x + 0.5) * image.width) / width - 0.5);
      const left = Math.floor(sourceX),
        right = Math.min(left + 1, image.width - 1);
      const fx = sourceX - left;
      const positions = [
        top * image.width + left,
        top * image.width + right,
        bottom * image.width + left,
        bottom * image.width + right,
      ];
      const weights = [
        (1 - fx) * (1 - fy),
        fx * (1 - fy),
        (1 - fx) * fy,
        fx * fy,
      ];
      const alphas = positions.map((position) =>
        hasAlpha
          ? image.data[position * image.channels + image.channels - 1] / max
          : 1
      );
      const alpha = alphas.reduce(
        (sum, value, index) => sum + value * weights[index],
        0
      );
      const to = (y * width + x) * image.channels;
      for (let channel = 0; channel < image.channels; channel++) {
        if (hasAlpha && channel === image.channels - 1) {
          data[to + channel] = Math.round(alpha * max);
          continue;
        }
        const value = positions.reduce(
          (sum, position, index) =>
            sum +
            image.data[position * image.channels + channel] *
              weights[index] *
              (alpha ? alphas[index] : 1),
          0
        );
        data[to + channel] = Math.round(alpha ? value / alpha : value);
      }
    }
  }
  return { ...image, width, height, data };
}

export async function compressImage(
  file: File,
  mode: CompressionMode,
  signal?: AbortSignal
): Promise<ImageCompressionResult> {
  checkImageCancelled(signal);
  if (!file.size || file.size > IMAGE_INPUT_LIMITS.fileBytes)
    throw new Error("圖片不可為空，且單張不可超過 64 MB。");
  if (!["low", "medium", "high"].includes(mode))
    throw new Error("請選擇有效的壓縮方式。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkImageCancelled(signal);
  const info = inspectImageBytes(bytes);
  const type = info.format === "jpg" ? "image/jpeg" : "image/png";
  let result: ImageCompressionResult = { blob: file, appliedMode: "low" };
  function consider(encoded: Uint8Array, appliedMode: CompressionMode) {
    checkImageCancelled(signal);
    if (encoded.length < result.blob.size)
      result = {
        blob: new Blob([new Uint8Array(encoded)], { type }),
        appliedMode,
      };
  }
  consider(stripMetadata(bytes, info.format), "low");
  if (mode === "low") return result;
  const image = transformPixels(
    await decodePixels(bytes, info, signal),
    info,
    0,
    signal
  );
  async function encode(pixels: ImagePixels, appliedMode: "medium" | "high") {
    const encoded =
      info.format === "png"
        ? encodeOptimizedPng(pixels, signal)
        : jpegWithProfile(
            await encodeJpeg(
              rgba8(pixels, true),
              pixels.channels < 3,
              signal,
              appliedMode === "high" ? 65 : 80
            ),
            pixels.profile
          );
    consider(encoded, appliedMode);
  }
  await encode(image, "medium");
  if (mode === "high") await encode(resizePixels(image, signal), "high");
  checkImageCancelled(signal);
  return result;
}
