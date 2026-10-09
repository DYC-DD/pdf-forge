import { convertIndexedToRgb, decode, encode } from "fast-png";

import {
  checkImageCancelled,
  decodeImage,
  makeImageCanvas,
} from "./imageCanvas";
import { decodeJpeg, encodeJpeg, encodeLosslessWebp } from "./imageCodecs";
import {
  jpegProfile,
  jpegSegments,
  jpegWithProfile,
  pngBytes,
  pngChunks,
  pngColorChunks,
  pngProfile,
  profileChunk,
  profileSpace,
  svgTransform,
  webpWithProfile,
  withoutOrientation,
  type PngChunk,
} from "./imageMetadata";
import type { ImageInfo } from "./imageSource";

export type ImagePixels = {
  width: number;
  height: number;
  channels: number;
  depth: 8 | 16;
  data: Uint8Array | Uint16Array;
  profile?: Uint8Array;
  colorChunks: PngChunk[];
};

export function decodePngPixels(bytes: Uint8Array): ImagePixels {
  const chunks = pngChunks(bytes);
  if (chunks.some(({ type }) => type === "acTL"))
    throw new Error("目前僅支援靜態 PNG，請先將動態 PNG 儲存為單張圖片。");
  // Decode only pixels; compressed optional text/profile metadata has separate limits.
  const decoded = decode(
    pngBytes(
      chunks.filter(({ type }) =>
        ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)
      )
    ),
    { checkCrc: true }
  );
  let { data, channels } = decoded;
  const depth = decoded.depth === 16 ? 16 : 8;
  const max = depth === 16 ? 65535 : 255;
  if (decoded.palette) {
    data = convertIndexedToRgb(decoded);
    channels = decoded.palette[0].length;
  } else if (decoded.depth < 8) {
    const unpacked = new Uint8Array(decoded.width * decoded.height);
    const stride = Math.ceil((decoded.width * decoded.depth) / 8);
    const mask = (1 << decoded.depth) - 1;
    for (let y = 0; y < decoded.height; y++)
      for (let x = 0; x < decoded.width; x++) {
        const bit = x * decoded.depth;
        unpacked[y * decoded.width + x] = Math.round(
          (((data[y * stride + (bit >>> 3)] >>>
            (8 - decoded.depth - (bit % 8))) &
            mask) *
            255) /
            mask
        );
      }
    data = unpacked;
  }
  if (decoded.transparency && (channels === 1 || channels === 3)) {
    const expanded =
      depth === 16
        ? new Uint16Array(decoded.width * decoded.height * (channels + 1))
        : new Uint8Array(decoded.width * decoded.height * (channels + 1));
    for (let pixel = 0; pixel < decoded.width * decoded.height; pixel++) {
      let transparent = true;
      for (let channel = 0; channel < channels; channel++) {
        const sample = data[pixel * channels + channel];
        expanded[pixel * (channels + 1) + channel] = sample;
        const key =
          decoded.depth < 8
            ? Math.round(
                (decoded.transparency[channel] * 255) /
                  ((1 << decoded.depth) - 1)
              )
            : decoded.transparency[channel];
        if (sample !== key) transparent = false;
      }
      expanded[pixel * (channels + 1) + channels] = transparent ? 0 : max;
    }
    data = expanded;
    channels++;
  }
  const profile = pngProfile(chunks);
  if (profile && profileSpace(profile) !== (channels < 3 ? "GRAY" : "RGB "))
    throw new Error("PNG 色彩描述檔與圖片色彩通道不一致，請重新儲存後再試。");
  return {
    width: decoded.width,
    height: decoded.height,
    channels,
    depth,
    data:
      data instanceof Uint16Array
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    profile,
    colorChunks: pngColorChunks(chunks),
  };
}

// Used for color spaces that cannot be copied directly into an RGB output profile.
async function decodeSrgb(
  bytes: Uint8Array,
  info: ImageInfo,
  signal?: AbortSignal
): Promise<ImagePixels> {
  const file = new File(
    [withoutOrientation(bytes, info.format)],
    `source.${info.format}`,
    {
      type: info.format === "jpg" ? "image/jpeg" : "image/png",
    }
  );
  const decoded = await decodeImage(file, signal);
  const canvas = makeImageCanvas(info.width, info.height);
  try {
    if (decoded.width !== info.width || decoded.height !== info.height)
      throw new Error("圖片方向或尺寸無法正確辨識。");
    const context = canvas.getContext("2d", {
      colorSpace: "srgb",
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("無法讀取圖片色彩。");
    context.drawImage(decoded.image, 0, 0);
    const image = context.getImageData(0, 0, info.width, info.height);
    return {
      width: info.width,
      height: info.height,
      channels: 4,
      depth: 8,
      data: new Uint8Array(
        image.data.buffer,
        image.data.byteOffset,
        image.data.byteLength
      ),
      colorChunks: [],
    };
  } finally {
    decoded.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function decodePixels(
  bytes: Uint8Array,
  info: ImageInfo,
  signal?: AbortSignal
): Promise<ImagePixels> {
  checkImageCancelled(signal);
  if (info.format === "png") return decodePngPixels(bytes);
  const frame = jpegSegments(bytes).find(
    ({ marker }) =>
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
  );
  if (frame?.data[5] === 4) return decodeSrgb(bytes, info, signal);
  const profile = jpegProfile(bytes);
  const image = await decodeJpeg(bytes, signal);
  if (image.width !== info.width || image.height !== info.height)
    throw new Error("JPG 圖片尺寸無法正確辨識。");
  const grayscale = frame?.data[5] === 1;
  if (profile && profileSpace(profile) !== (grayscale ? "GRAY" : "RGB "))
    throw new Error("JPG 色彩描述檔與圖片色彩通道不一致，請重新儲存後再試。");
  const data = grayscale
    ? Uint8Array.from(
        { length: image.width * image.height },
        (_, index) => image.data[index * 4]
      )
    : new Uint8Array(
        image.data.buffer,
        image.data.byteOffset,
        image.data.byteLength
      );
  return {
    width: image.width,
    height: image.height,
    channels: grayscale ? 1 : 4,
    depth: 8,
    data,
    profile,
    colorChunks: profile ? [profileChunk(profile)] : [],
  };
}

export function transformPixels(
  image: ImagePixels,
  info: ImageInfo,
  rotation: number,
  signal?: AbortSignal
): ImagePixels {
  if (info.orientation === 1 && rotation === 0) return image;
  const {
    size,
    matrix: [a, b, c, d, e, f],
  } = svgTransform(info, rotation);
  const data =
    image.depth === 16
      ? new Uint16Array(size.width * size.height * image.channels)
      : new Uint8Array(size.width * size.height * image.channels);
  for (let y = 0; y < image.height; y++) {
    checkImageCancelled(signal);
    for (let x = 0; x < image.width; x++) {
      const destX = Math.floor(a * (x + 0.5) + c * (y + 0.5) + e);
      const destY = Math.floor(b * (x + 0.5) + d * (y + 0.5) + f);
      const from = (y * image.width + x) * image.channels;
      const to = (destY * size.width + destX) * image.channels;
      for (let channel = 0; channel < image.channels; channel++)
        data[to + channel] = image.data[from + channel];
    }
  }
  return { ...image, ...size, data };
}

export function rgba8(image: ImagePixels, white = false): ImageData {
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  const max = image.depth === 16 ? 65535 : 255;
  const grayscale = image.channels < 3;
  const hasAlpha = image.channels === 2 || image.channels === 4;
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const from = pixel * image.channels;
    const alpha = hasAlpha ? image.data[from + image.channels - 1] / max : 1;
    for (let channel = 0; channel < 3; channel++) {
      const sample = image.data[from + (grayscale ? 0 : channel)] / max;
      data[pixel * 4 + channel] = Math.round(
        (white ? sample * alpha + 1 - alpha : sample) * 255
      );
    }
    data[pixel * 4 + 3] = white ? 255 : Math.round(alpha * 255);
  }
  // Codecs accept ImageData's fields; no browser constructor or Canvas is needed.
  return { width: image.width, height: image.height, data, colorSpace: "srgb" };
}

export function encodePngPixels(image: ImagePixels) {
  const encoded = encode(image);
  const chunks = pngChunks(encoded);
  return pngBytes([chunks[0], ...image.colorChunks, ...chunks.slice(1)]);
}

export async function exportRaster(
  bytes: Uint8Array,
  info: ImageInfo,
  rotation: number,
  format: "jpg" | "png" | "webp",
  signal?: AbortSignal
) {
  let image = await decodePixels(bytes, info, signal);
  // Non-ICC PNG gamma/chromaticity needs color management before 8-bit RGB encoding.
  const gamma = image.colorChunks.find(({ type }) => type === "gAMA");
  const customGamma =
    gamma &&
    new DataView(
      gamma.data.buffer,
      gamma.data.byteOffset,
      gamma.data.byteLength
    ).getUint32(0) !== 45455;
  if (
    format !== "png" &&
    ((format === "webp" && profileSpace(image.profile) === "GRAY") ||
      (!image.profile &&
        !image.colorChunks.some(({ type }) => type === "sRGB") &&
        (customGamma || image.colorChunks.some(({ type }) => type === "cHRM"))))
  )
    image = await decodeSrgb(bytes, info, signal);
  image = transformPixels(image, info, rotation, signal);
  checkImageCancelled(signal);
  if (format === "png")
    return new Blob([encodePngPixels(image)], { type: "image/png" });
  if (format === "jpg") {
    const encoded = await encodeJpeg(
      rgba8(image, true),
      image.channels < 3,
      signal
    );
    return new Blob([jpegWithProfile(encoded, image.profile)], {
      type: "image/jpeg",
    });
  }
  const encoded = await encodeLosslessWebp(rgba8(image), signal);
  return new Blob(
    [webpWithProfile(encoded, image.width, image.height, image.profile)],
    { type: "image/webp" }
  );
}
