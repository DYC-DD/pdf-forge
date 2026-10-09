import { unzlibSync, zlibSync } from "fflate";

import { imageTransform, type ImageInfo } from "./imageSource";

const text = new TextDecoder("ascii");
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const profileLimit = 4 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
export type PngChunk = { type: string; data: Uint8Array };

export function joinBytes(parts: readonly Uint8Array[]) {
  const joined = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  );
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

function pngCrc(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunks(bytes: Uint8Array): PngChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = view.getUint32(at);
    if (length > bytes.length - at - 12)
      throw new Error("PNG 檔案內容不完整。");
    if (
      view.getUint32(at + 8 + length) !==
      pngCrc(bytes.subarray(at + 4, at + 8 + length))
    )
      throw new Error("PNG 檔案內容損壞，請重新儲存後再試。");
    const type = text.decode(bytes.subarray(at + 4, at + 8));
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += length + 12;
    if (type === "IEND") return chunks;
  }
  throw new Error("PNG 檔案內容不完整。");
}

export function pngChunk({ type, data }: PngChunk) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(bytes.length - 4, pngCrc(bytes.subarray(4, bytes.length - 4)));
  return bytes;
}

export function pngBytes(chunks: readonly PngChunk[]) {
  return joinBytes([signature, ...chunks.map(pngChunk)]);
}

export function pngColorChunks(chunks: readonly PngChunk[]) {
  return chunks.filter((chunk) =>
    ["iCCP", "sRGB", "gAMA", "cHRM", "cICP", "mDCV", "cLLI"].includes(
      chunk.type
    )
  );
}

export function validProfile(profile: Uint8Array) {
  if (
    profile.length < 128 ||
    profile.length > profileLimit ||
    new DataView(
      profile.buffer,
      profile.byteOffset,
      profile.byteLength
    ).getUint32(0) !== profile.length ||
    text.decode(profile.subarray(36, 40)) !== "acsp"
  )
    throw new Error("圖片的色彩描述檔無法讀取，請重新儲存圖片後再試。");
  return new Uint8Array(profile);
}

export function profileSpace(profile?: Uint8Array) {
  return profile ? text.decode(profile.subarray(16, 20)) : undefined;
}

export function pngProfile(chunks: readonly PngChunk[]) {
  const data = chunks.find((chunk) => chunk.type === "iCCP")?.data;
  if (!data) return undefined;
  const separator = data.indexOf(0);
  if (separator < 1 || separator > 79 || data[separator + 1] !== 0)
    throw new Error("PNG 的色彩描述檔無法讀取。");
  // A fixed output buffer prevents compressed metadata from allocating unbounded memory.
  return validProfile(
    unzlibSync(data.subarray(separator + 2), {
      out: new Uint8Array(profileLimit),
    })
  );
}

export function profileChunk(profile: Uint8Array): PngChunk {
  return {
    type: "iCCP",
    data: joinBytes([new TextEncoder().encode("ICC\0\0"), zlibSync(profile)]),
  };
}

export function jpegSegments(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments: {
    marker: number;
    start: number;
    end: number;
    data: Uint8Array;
  }[] = [];
  for (let at = 2; at + 4 <= bytes.length;) {
    const start = at;
    if (bytes[at++] !== 255) break;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) break;
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length) break;
    segments.push({
      marker,
      start,
      end: at + length,
      data: bytes.subarray(at + 2, at + length),
    });
    at += length;
  }
  return segments;
}

export function jpegProfile(bytes: Uint8Array) {
  const segments = jpegSegments(bytes).filter(
    ({ marker, data }) =>
      marker === 0xe2 && text.decode(data.subarray(0, 12)) === "ICC_PROFILE\0"
  );
  if (!segments.length) return undefined;
  const count = segments[0].data[13];
  const sorted = segments.sort((a, b) => a.data[12] - b.data[12]);
  if (
    !count ||
    count !== sorted.length ||
    sorted.some(({ data }, i) => data[12] !== i + 1 || data[13] !== count) ||
    sorted.reduce((sum, { data }) => sum + data.length - 14, 0) > profileLimit
  )
    throw new Error("JPG 的色彩描述檔不完整。");
  return validProfile(joinBytes(sorted.map(({ data }) => data.subarray(14))));
}

export function jpegWithProfile(
  bytes: Uint8Array<ArrayBuffer>,
  profile?: Uint8Array
) {
  if (!profile) return bytes;
  const parts = [bytes.subarray(0, 2)];
  const size = 65519;
  const count = Math.ceil(profile.length / size);
  for (let index = 0; index < count; index++) {
    const data = profile.subarray(index * size, (index + 1) * size);
    const segment = new Uint8Array(data.length + 18);
    segment.set([255, 226]);
    new DataView(segment.buffer).setUint16(2, data.length + 16);
    segment.set(new TextEncoder().encode("ICC_PROFILE\0"), 4);
    segment[16] = index + 1;
    segment[17] = count;
    segment.set(data, 18);
    parts.push(segment);
  }
  let at = 2;
  for (const { marker, data, start, end } of jpegSegments(bytes)) {
    if (
      marker !== 0xe2 ||
      text.decode(data.subarray(0, 12)) !== "ICC_PROFILE\0"
    )
      continue;
    parts.push(bytes.subarray(at, start));
    at = end;
  }
  return joinBytes([...parts, bytes.subarray(at)]);
}

export function withoutOrientation(
  bytes: Uint8Array,
  format: ImageInfo["format"]
) {
  if (format === "png")
    return pngBytes(pngChunks(bytes).filter(({ type }) => type !== "eXIf"));
  const exif = jpegSegments(bytes).filter(
    ({ marker, data }) =>
      marker === 0xe1 && text.decode(data.subarray(0, 6)) === "Exif\0\0"
  );
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const { start, end } of exif) {
    parts.push(bytes.subarray(at, start));
    at = end;
  }
  return joinBytes([...parts, bytes.subarray(at)]);
}

export function svgTransform(info: ImageInfo, rotation: number) {
  const {
    size,
    matrix: [a, b, c, d, e, f],
  } = imageTransform(info, rotation);
  return {
    size,
    matrix: [
      a,
      -b,
      -c,
      d,
      c * info.height + e,
      size.height - d * info.height - f,
    ],
  };
}

export function webpWithProfile(
  bytes: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  profile?: Uint8Array
) {
  if (!profile) return bytes;
  const chunk = (type: string, data: Uint8Array) => {
    const result = new Uint8Array(8 + data.length + (data.length % 2));
    result.set(new TextEncoder().encode(type));
    new DataView(result.buffer).setUint32(4, data.length, true);
    result.set(data, 8);
    return result;
  };
  const extended = new Uint8Array(10);
  const hasAlpha = !!(bytes[24] & 0x10); // libwebp lossless VP8L header.
  extended[0] = 0x20 | (hasAlpha ? 0x10 : 0);
  for (let byte = 0; byte < 3; byte++) {
    extended[4 + byte] = (width - 1) >>> (8 * byte);
    extended[7 + byte] = (height - 1) >>> (8 * byte);
  }
  const result = joinBytes([
    bytes.subarray(0, 12),
    chunk("VP8X", extended),
    chunk("ICCP", profile),
    bytes.subarray(12),
  ]);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}
