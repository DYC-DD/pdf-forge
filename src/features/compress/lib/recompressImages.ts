import type { CompressionMode } from "../types";

const HIGH_MAX_IMAGE_EDGE = 1800;
const MIN_JPEG_BYTES = 16_384;

export async function recompressJpegImages(
  input: Uint8Array,
  mode: Extract<CompressionMode, "medium" | "high">
): Promise<Uint8Array | null> {
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    return null;
  }

  const { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } =
    await import("pdf-lib");
  const document = await PDFDocument.load(input, { updateMetadata: false });
  let changed = false;

  for (const [
    reference,
    object,
  ] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    const lookup = (name: string) =>
      document.context.lookup(dict.get(PDFName.of(name)));
    const subtype = lookup("Subtype");
    const filter = lookup("Filter");
    const jpegFilter =
      filter instanceof PDFName
        ? filter.asString() === "/DCTDecode"
        : filter instanceof PDFArray &&
          filter.size() === 1 &&
          document.context.lookup(filter.get(0))?.toString() === "/DCTDecode";
    const colorSpace = lookup("ColorSpace");
    const bits = lookup("BitsPerComponent");
    const widthValue = lookup("Width");
    const heightValue = lookup("Height");
    const width =
      widthValue instanceof PDFNumber ? widthValue.asNumber() : undefined;
    const height =
      heightValue instanceof PDFNumber ? heightValue.asNumber() : undefined;

    const supportedColorSpace =
      colorSpace instanceof PDFName
        ? ["/DeviceRGB", "/DeviceGray"].includes(colorSpace.asString())
        : colorSpace instanceof PDFArray &&
          document.context.lookup(colorSpace.get(0))?.toString() ===
            "/ICCBased" &&
          (() => {
            const profile = document.context.lookup(colorSpace.get(1));
            if (!(profile instanceof PDFRawStream)) return false;
            const components = document.context.lookup(
              profile.dict.get(PDFName.of("N"))
            );
            return (
              components instanceof PDFNumber &&
              [1, 3].includes(components.asNumber())
            );
          })();

    if (
      !(subtype instanceof PDFName) ||
      subtype.asString() !== "/Image" ||
      !jpegFilter ||
      !supportedColorSpace ||
      !(bits instanceof PDFNumber) ||
      bits.asNumber() !== 8 ||
      !width ||
      !height ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      object.getContentsSize() < MIN_JPEG_BYTES ||
      dict.has(PDFName.of("SMask")) ||
      dict.has(PDFName.of("Mask")) ||
      dict.has(PDFName.of("Decode")) ||
      dict.has(PDFName.of("DecodeParms"))
    ) {
      continue;
    }

    let bitmap: ImageBitmap | null = null;
    try {
      const original = object.getContents();
      bitmap = await createImageBitmap(
        new Blob([new Uint8Array(original)], { type: "image/jpeg" })
      );
      if (bitmap.width !== width || bitmap.height !== height) continue;

      const maxEdge =
        mode === "high" ? HIGH_MAX_IMAGE_EDGE : Math.max(width, height);
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const canvas = new OffscreenCanvas(targetWidth, targetHeight);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) continue;
      context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      const jpeg = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: mode === "high" ? 0.62 : 0.82,
      });
      if (jpeg.type !== "image/jpeg" || jpeg.size >= original.length) {
        continue;
      }

      const replacementDict = dict.clone(document.context);
      replacementDict.set(PDFName.of("Width"), PDFNumber.of(targetWidth));
      replacementDict.set(PDFName.of("Height"), PDFNumber.of(targetHeight));
      replacementDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
      replacementDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      const replacement = PDFRawStream.of(
        replacementDict,
        new Uint8Array(await jpeg.arrayBuffer())
      );
      document.context.assign(reference, replacement);
      changed = true;
    } catch {
      // Keep image streams that the browser cannot safely decode or re-encode.
    } finally {
      bitmap?.close();
    }
  }

  return changed
    ? new Uint8Array(await document.save({ updateFieldAppearances: false }))
    : null;
}
