import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";

import { packImageZip } from "../../../shared/files/imageZip";
import { checkImageCancelled } from "./imageCanvas";
import { svgTransform, withoutOrientation } from "./imageMetadata";
import { embedBestImage } from "./imagePdf";
import { exportRaster } from "./imagePixels";
import {
  conversionStem,
  IMAGE_INPUT_LIMITS,
  imageInputsError,
  imageTransform,
  inspectImageBytes,
  type ImageInfo,
  type ImageInput,
} from "./imageSource";

export type ImageOutputFormat = "pdf" | "jpg" | "png" | "svg" | "webp";
export type ImageConversionOptions = {
  format: ImageOutputFormat;
  outputName: string;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
  onPackingProgress?: (percent: number) => void;
};
export type ImageConversionResult = {
  blob: Blob;
  filename: string;
  fileCount: number;
};

function svgImage(bytes: Uint8Array, info: ImageInfo, rotation: number) {
  const { size, matrix } = svgTransform(info, rotation);
  const embedded =
    info.orientation === 1 ? bytes : withoutOrientation(bytes, info.format);
  let binary = "";
  for (let at = 0; at < embedded.length; at += 32768)
    binary += String.fromCharCode(...embedded.subarray(at, at + 32768));
  return new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><image width="${info.width}" height="${info.height}" transform="matrix(${matrix.join(" ")})" xlink:href="data:image/${info.format === "jpg" ? "jpeg" : "png"};base64,${btoa(binary)}"/></svg>`,
    ],
    { type: "image/svg+xml" }
  );
}

export async function convertImages(
  inputs: readonly ImageInput[],
  options: ImageConversionOptions
): Promise<ImageConversionResult> {
  checkImageCancelled(options.signal);
  const error = imageInputsError(inputs.map((input) => input.file));
  if (error) throw new Error(error);
  if (!["pdf", "jpg", "png", "svg", "webp"].includes(options.format))
    throw new Error("請選擇有效的輸出格式。");
  if (inputs.some((input) => ![0, 90, 180, 270].includes(input.rotation)))
    throw new Error("圖片旋轉角度不正確。");
  const stem = conversionStem(options.outputName);
  const pdf = options.format === "pdf" ? await PDFDocument.create() : null;
  const zip =
    !pdf && inputs.length > 1 ? new (await import("jszip")).default() : null;
  const digits = Math.max(2, String(inputs.length).length);
  let single: Blob | undefined;
  let totalBytes = 0;
  for (let index = 0; index < inputs.length; index++) {
    checkImageCancelled(options.signal);
    const { file, rotation } = inputs[index];
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = inspectImageBytes(bytes);
    checkImageCancelled(options.signal);
    if (options.format === "pdf") {
      if (!pdf) throw new Error("無法建立 PDF。");
      const imageRef = await embedBestImage(pdf, bytes, info);
      const { size, matrix } = imageTransform(info, rotation);
      // Physical page size uses 300 DPI; original pixels and JPEG data stay intact.
      const scale = 72 / 300;
      const page = pdf.addPage([size.width * scale, size.height * scale]);
      const [a, b, c, d, e, f] = matrix.map((value) => value * scale);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(
          a * info.width,
          b * info.width,
          c * info.height,
          d * info.height,
          e,
          f
        ),
        drawObject(page.node.newXObject("Image", imageRef)),
        popGraphicsState()
      );
      // Check accumulated embedded streams before serializing a large document.
      totalBytes = pdf.context
        .enumerateIndirectObjects()
        .reduce(
          (sum, [, object]) =>
            sum +
            ("getContentsSize" in object &&
            typeof object.getContentsSize === "function"
              ? object.getContentsSize()
              : 0),
          0
        );
      if (totalBytes > IMAGE_INPUT_LIMITS.outputBytes)
        throw new Error("輸出 PDF 超過 128 MB，請分批轉換較少圖片。");
    } else {
      const original = new Blob([bytes], {
        type: info.format === "jpg" ? "image/jpeg" : "image/png",
      });
      const untouched = rotation === 0 && info.orientation === 1;
      let blob: Blob;
      if (options.format === "svg") {
        blob = svgImage(bytes, info, rotation);
      } else if (options.format === info.format && untouched) blob = original;
      else
        blob = await exportRaster(
          bytes,
          info,
          rotation,
          options.format,
          options.signal
        );
      checkImageCancelled(options.signal);
      totalBytes += blob.size;
      if (totalBytes > IMAGE_INPUT_LIMITS.outputBytes)
        throw new Error("輸出總大小超過 128 MB，請分批轉換較少圖片。");
      if (zip)
        zip.file(
          `${stem}-${String(index + 1).padStart(digits, "0")}.${options.format}`,
          await blob.arrayBuffer()
        );
      else single = blob;
    }
    options.onProgress?.(index + 1);
  }
  checkImageCancelled(options.signal);
  if (pdf) {
    const bytes = await pdf.save();
    checkImageCancelled(options.signal);
    if (bytes.length > IMAGE_INPUT_LIMITS.outputBytes)
      throw new Error("輸出 PDF 超過 128 MB，請分批轉換較少圖片。");
    return {
      blob: new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      filename: `${stem}.pdf`,
      fileCount: 1,
    };
  }
  if (single)
    return {
      blob: single,
      filename: `${stem}.${options.format}`,
      fileCount: 1,
    };
  if (!zip) throw new Error("無法建立轉換結果。");
  options.onPackingProgress?.(0);
  const blob = await packImageZip(
    zip,
    options.signal,
    options.onPackingProgress
  );
  checkImageCancelled(options.signal);
  return { blob, filename: `${stem}.zip`, fileCount: inputs.length };
}
