import { COMPRESSION_LIMITS } from "../../../shared/pdf/limits";

export type ImageBudget = { remainingPixels: number };

export function createImageBudget(): ImageBudget {
  return { remainingPixels: COMPRESSION_LIMITS.totalImagePixels };
}

export function imagePixels(width: number, height: number): number | null {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > COMPRESSION_LIMITS.imageEdge ||
    height > COMPRESSION_LIMITS.imageEdge ||
    width * height > COMPRESSION_LIMITS.imagePixels
  )
    return null;
  return width * height;
}

export function reserveImagePixels(
  budget: ImageBudget,
  pixels: number
): boolean {
  if (pixels > budget.remainingPixels) return false;
  budget.remainingPixels -= pixels;
  return true;
}

// Read the JPEG frame header before invoking a decoder: the PDF dictionary
// alone cannot be trusted to describe the memory required by the JPEG.
export function jpegDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === undefined) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (length < 8) return null;
      return {
        height: bytes[offset + 3] * 256 + bytes[offset + 4],
        width: bytes[offset + 5] * 256 + bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

// qpdf optimizes an entire document in one call, so only enable its image
// pass when every image and their total fit the same decoding budget.
export async function qpdfImagePixels(
  input: Uint8Array
): Promise<number | null> {
  const { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } =
    await import("pdf-lib");
  const document = await PDFDocument.load(input, { updateMetadata: false });
  let total = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const lookup = (name: string) =>
      document.context.lookup(object.dict.get(PDFName.of(name)));
    if (lookup("Subtype")?.toString() !== "/Image") continue;
    const width = lookup("Width");
    const height = lookup("Height");
    if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber))
      return null;
    const pixels = imagePixels(width.asNumber(), height.asNumber());
    if (pixels === null) return null;
    total += pixels;
    if (total > COMPRESSION_LIMITS.totalImagePixels) return null;
    const filter = lookup("Filter");
    const filters =
      filter instanceof PDFArray
        ? filter
            .asArray()
            .map((value) => document.context.lookup(value)?.toString())
        : [filter?.toString()];
    if (filters.includes("/DCTDecode")) {
      const dimensions = jpegDimensions(object.getContents());
      if (
        !dimensions ||
        dimensions.width !== width.asNumber() ||
        dimensions.height !== height.asNumber()
      )
        return null;
    }
  }
  return total;
}
