import { fileStem } from "../../../shared/files/file";

export function conversionStem(name: string) {
  return fileStem(
    name.trim().replace(/\.(?:pdf|jpe?g|png|svg|webp|zip)$/i, "")
  );
}

export const IMAGE_INPUT_LIMITS = {
  files: 100,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  pixels: 40_000_000,
  edge: 16384,
  outputBytes: 128 * 1024 * 1024,
} as const;

export type ImageInfo = {
  format: "jpg" | "png";
  width: number;
  height: number;
  orientation: number;
};
export type ImageInput = { file: File; rotation: number };
export type ImageItem = ImageInput & {
  id: string;
  info?: ImageInfo;
  thumbnail?: string;
  loading: boolean;
  error?: string;
};

export function sourceType(bytes: Uint8Array): "pdf" | "jpg" | "png" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return "png";
  if (new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-"))
    return "pdf";
  return null;
}

export async function detectSources(files: readonly File[]) {
  if (!files.length) throw new Error("請加入 PDF 或 JPG／PNG 圖片。");
  if (files.length > IMAGE_INPUT_LIMITS.files)
    throw new Error("一次最多可加入 100 張圖片。");
  const types = [];
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name} 是空的檔案。`);
    if (file.size > IMAGE_INPUT_LIMITS.fileBytes)
      throw new Error("單一檔案不可超過 64 MB。");
    const type = sourceType(
      new Uint8Array(await file.slice(0, 1024).arrayBuffer())
    );
    if (!type)
      throw new Error(`${file.name} 格式不支援，請加入 PDF、JPG 或 PNG。`);
    types.push(type);
  }
  if (types.includes("pdf")) {
    if (types.some((type) => type !== "pdf"))
      throw new Error("請分開加入 PDF 或圖片。");
    if (files.length !== 1) throw new Error("一次請加入一份 PDF。");
    return "pdf" as const;
  }
  return "images" as const;
}

export function imageInputsError(files: readonly File[]) {
  if (!files.length) return "請加入至少一張圖片。";
  if (files.length > IMAGE_INPUT_LIMITS.files)
    return "一次最多可加入 100 張圖片。";
  if (
    files.some((file) => !file.size || file.size > IMAGE_INPUT_LIMITS.fileBytes)
  )
    return "圖片不可為空，且單張不可超過 64 MB。";
  if (
    files.reduce((sum, file) => sum + file.size, 0) >
    IMAGE_INPUT_LIMITS.totalBytes
  )
    return "圖片總大小不可超過 128 MB，請分批轉換。";
  return null;
}

function exifOrientation(bytes: Uint8Array, start: number, end: number) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (start + 8 > end) return 1;
    const little = view.getUint16(start) === 0x4949;
    if (!little && view.getUint16(start) !== 0x4d4d) return 1;
    if (view.getUint16(start + 2, little) !== 42) return 1;
    const directory = start + view.getUint32(start + 4, little);
    if (directory < start || directory + 2 > end) return 1;
    const count = view.getUint16(directory, little);
    for (let i = 0; i < count; i++) {
      const entry = directory + 2 + i * 12;
      if (entry + 12 > end) return 1;
      if (view.getUint16(entry, little) !== 0x0112) continue;
      if (
        view.getUint16(entry + 2, little) !== 3 ||
        view.getUint32(entry + 4, little) !== 1
      )
        return 1;
      const orientation = view.getUint16(entry + 8, little);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  } catch {
    /* Ignore malformed optional orientation metadata. */
  }
  return 1;
}

export function inspectImageBytes(bytes: Uint8Array): ImageInfo {
  const format = sourceType(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let orientation = 1;
  if (
    format === "png" &&
    bytes.length >= 33 &&
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49484452
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = view.getUint32(at);
      if (length > bytes.length - at - 12) break;
      if (view.getUint32(at + 4) === 0x6163544c)
        throw new Error("目前僅支援靜態 PNG，請先將動態 PNG 儲存為單張圖片。");
      if (view.getUint32(at + 4) === 0x65584966)
        orientation = exifOrientation(bytes, at + 8, at + 8 + length);
      at += length + 12;
    }
  } else if (format === "jpg") {
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if (
        marker === 0xe1 &&
        length >= 16 &&
        new TextDecoder().decode(bytes.subarray(at + 2, at + 8)) === "Exif\0\0"
      )
        orientation = exifOrientation(bytes, at + 8, at + length);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker) &&
        length >= 8
      ) {
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
      }
      at += length;
    }
  }
  if ((format !== "jpg" && format !== "png") || !width || !height)
    throw new Error("圖片內容無法讀取，請重新選擇 JPG 或 PNG。");
  if (
    width > IMAGE_INPUT_LIMITS.edge ||
    height > IMAGE_INPUT_LIMITS.edge ||
    width * height > IMAGE_INPUT_LIMITS.pixels
  )
    throw new Error(
      "圖片尺寸超過上限：單張最多 4,000 萬像素、單邊 16,384 像素。"
    );
  return { format, width, height, orientation };
}

export function displayedSize(info: ImageInfo, rotation = 0) {
  const swapped = info.orientation >= 5 !== (rotation % 180 !== 0);
  return {
    width: swapped ? info.height : info.width,
    height: swapped ? info.width : info.height,
  };
}

// Map original bottom-left image coordinates into the oriented PDF page.
export function imageTransform(info: ImageInfo, rotation: number) {
  const { width: w, height: h, orientation: o } = info;
  const oriented = displayedSize(info);
  const size = displayedSize(info, rotation);
  const point = (x: number, y: number) => {
    y = h - y;
    [x, y] =
      o === 2
        ? [w - x, y]
        : o === 3
          ? [w - x, h - y]
          : o === 4
            ? [x, h - y]
            : o === 5
              ? [y, x]
              : o === 6
                ? [h - y, x]
                : o === 7
                  ? [h - y, w - x]
                  : o === 8
                    ? [y, w - x]
                    : [x, y];
    [x, y] =
      rotation === 90
        ? [oriented.height - y, x]
        : rotation === 180
          ? [oriented.width - x, oriented.height - y]
          : rotation === 270
            ? [y, oriented.width - x]
            : [x, y];
    return [x, size.height - y];
  };
  const [e, f] = point(0, 0);
  const [x1, y1] = point(1, 0);
  const [x2, y2] = point(0, 1);
  return { size, matrix: [x1 - e, y1 - f, x2 - e, y2 - f, e, f] as const };
}
