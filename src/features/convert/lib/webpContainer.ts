const text = new TextDecoder("ascii");

export type WebpChunk = { type: string; data: Uint8Array };

export function isWebp(bytes: Uint8Array) {
  return (
    bytes.length >= 12 &&
    text.decode(bytes.subarray(0, 4)) === "RIFF" &&
    text.decode(bytes.subarray(8, 12)) === "WEBP"
  );
}

export function webpChunks(bytes: Uint8Array): WebpChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isWebp(bytes) || view.getUint32(4, true) !== bytes.length - 8)
    throw new Error("WEBP 檔案內容不完整，請重新儲存後再試。");
  const chunks: WebpChunk[] = [];
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) throw new Error("WEBP 檔案內容不完整。");
    const length = view.getUint32(at + 4, true);
    const end = at + 8 + length;
    const next = end + (length % 2);
    if (next > bytes.length || (length % 2 && bytes[end] !== 0))
      throw new Error("WEBP 檔案內容損壞，請重新儲存後再試。");
    chunks.push({
      type: text.decode(bytes.subarray(at, at + 4)),
      data: bytes.subarray(at + 8, end),
    });
    at = next;
  }
  return chunks;
}

export function webpBytes(chunks: readonly WebpChunk[]) {
  const bytes = new Uint8Array(
    12 +
      chunks.reduce(
        (size, { data }) => size + 8 + data.length + (data.length % 2),
        0
      )
  );
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"));
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  let at = 12;
  for (const { type, data } of chunks) {
    bytes.set(new TextEncoder().encode(type), at);
    view.setUint32(at + 4, data.length, true);
    bytes.set(data, at + 8);
    at += 8 + data.length + (data.length % 2);
  }
  return bytes;
}

export function inspectWebp(bytes: Uint8Array) {
  const chunks = webpChunks(bytes);
  const extended = chunks.find(({ type }) => type === "VP8X")?.data;
  if (
    (extended && extended[0] & 0x02) ||
    chunks.some(({ type }) => type === "ANIM" || type === "ANMF")
  )
    throw new Error("目前僅支援靜態 WEBP，請先將動態 WEBP 儲存為單張圖片。");
  const frames = chunks.filter(
    ({ type }) => type === "VP8 " || type === "VP8L"
  );
  if (
    frames.length !== 1 ||
    chunks.filter(({ type }) => type === "VP8X").length > 1 ||
    (extended && (extended.length !== 10 || chunks[0].type !== "VP8X"))
  )
    throw new Error("WEBP 圖片內容無法讀取。");
  const { type, data } = frames[0];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width: number, height: number;
  if (type === "VP8L") {
    if (data.length < 5 || data[0] !== 0x2f || data[4] >>> 5 !== 0)
      throw new Error("WEBP 圖片內容無法讀取。");
    const dimensions = view.getUint32(1, true);
    width = (dimensions & 0x3fff) + 1;
    height = ((dimensions >>> 14) & 0x3fff) + 1;
  } else {
    if (
      data.length < 10 ||
      data[0] & 1 ||
      data[3] !== 0x9d ||
      data[4] !== 0x01 ||
      data[5] !== 0x2a
    )
      throw new Error("WEBP 圖片內容無法讀取。");
    width = view.getUint16(6, true) & 0x3fff;
    height = view.getUint16(8, true) & 0x3fff;
  }
  if (extended) {
    const uint24 = (at: number) =>
      extended[at] + (extended[at + 1] << 8) + (extended[at + 2] << 16) + 1;
    // Check both headers before allocating decoded pixels, including forged canvases.
    if (width !== uint24(4) || height !== uint24(7))
      throw new Error("WEBP 圖片尺寸不一致，請重新儲存後再試。");
  }
  return {
    width,
    height,
    exif: chunks.find(({ type }) => type === "EXIF")?.data,
  };
}
