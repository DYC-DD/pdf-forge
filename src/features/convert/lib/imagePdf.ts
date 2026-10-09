import { PDFDocument, PDFName, PDFRawStream, type PDFRef } from "pdf-lib";

import { jpegProfile, profileSpace } from "./imageMetadata";
import { decodePngPixels, type ImagePixels } from "./imagePixels";
import type { ImageInfo } from "./imageSource";

function iccSpace(
  pdf: PDFDocument,
  profile: Uint8Array | undefined,
  components: number
) {
  if (!profile)
    return components === 1
      ? "DeviceGray"
      : components === 4
        ? "DeviceCMYK"
        : "DeviceRGB";
  if (
    profileSpace(profile) !==
    (components === 1 ? "GRAY" : components === 4 ? "CMYK" : "RGB ")
  )
    throw new Error("圖片色彩描述檔與圖片色彩通道不一致，請重新儲存後再試。");
  const ref = pdf.context.register(
    pdf.context.flateStream(profile, { N: components })
  );
  return ["ICCBased", ref];
}

function pngSpace(pdf: PDFDocument, image: ImagePixels, components: number) {
  if (image.profile || image.colorChunks.some(({ type }) => type === "sRGB"))
    return iccSpace(pdf, image.profile, components);
  const gammaChunk = image.colorChunks.find(({ type }) => type === "gAMA");
  const chromaChunk = image.colorChunks.find(({ type }) => type === "cHRM");
  if (!gammaChunk && !chromaChunk) return iccSpace(pdf, undefined, components);
  const gamma =
    gammaChunk && gammaChunk.data.length === 4
      ? 100000 /
        new DataView(
          gammaChunk.data.buffer,
          gammaChunk.data.byteOffset,
          4
        ).getUint32(0)
      : 2.2;
  if (!Number.isFinite(gamma) || gamma <= 0)
    throw new Error("PNG 色彩資訊無法讀取。");
  const chroma =
    chromaChunk && chromaChunk.data.length === 32
      ? Array.from(
          { length: 8 },
          (_, i) =>
            new DataView(
              chromaChunk.data.buffer,
              chromaChunk.data.byteOffset,
              32
            ).getUint32(i * 4) / 100000
        )
      : [0.3127, 0.329, 0.64, 0.33, 0.3, 0.6, 0.15, 0.06];
  const [wx, wy, rx, ry, gx, gy, bx, by] = chroma;
  if ([wy, ry, gy, by].some((value) => value <= 0))
    throw new Error("PNG 色彩資訊無法讀取。");
  const white = [wx / wy, 1, (1 - wx - wy) / wy];
  if (components === 1) return ["CalGray", { WhitePoint: white, Gamma: gamma }];
  const red = [rx / ry, 1, (1 - rx - ry) / ry];
  const green = [gx / gy, 1, (1 - gx - gy) / gy];
  const blue = [bx / by, 1, (1 - bx - by) / by];
  const determinant = (a: number[], b: number[], c: number[]) =>
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    b[0] * (a[1] * c[2] - a[2] * c[1]) +
    c[0] * (a[1] * b[2] - a[2] * b[1]);
  const denominator = determinant(red, green, blue);
  if (!denominator) throw new Error("PNG 色彩資訊無法讀取。");
  const scales = [
    determinant(white, green, blue),
    determinant(red, white, blue),
    determinant(red, green, white),
  ].map((value) => value / denominator);
  return [
    "CalRGB",
    {
      WhitePoint: white,
      Gamma: [gamma, gamma, gamma],
      Matrix: [red, green, blue].flatMap((column, i) =>
        column.map((value) => value * scales[i])
      ),
    },
  ];
}

export async function embedBestImage(
  pdf: PDFDocument,
  bytes: Uint8Array,
  info: ImageInfo
): Promise<PDFRef> {
  if (info.format === "jpg") {
    const image = await pdf.embedJpg(bytes);
    await image.embed();
    const stream = pdf.context.lookup(image.ref);
    if (!(stream instanceof PDFRawStream))
      throw new Error("無法嵌入 JPG 圖片。");
    const space = stream.dict.get(PDFName.of("ColorSpace"))?.toString();
    stream.dict.set(
      PDFName.of("ColorSpace"),
      pdf.context.obj(
        iccSpace(
          pdf,
          jpegProfile(bytes),
          space === "/DeviceGray" ? 1 : space === "/DeviceCMYK" ? 4 : 3
        )
      )
    );
    return image.ref;
  }
  const image = decodePngPixels(bytes);
  const components = image.channels < 3 ? 1 : 3;
  const hasAlpha = image.channels === 2 || image.channels === 4;
  const bytesPerSample = image.depth / 8;
  const color = new Uint8Array(
    image.width * image.height * components * bytesPerSample
  );
  const alpha = hasAlpha
    ? new Uint8Array(image.width * image.height * bytesPerSample)
    : undefined;
  const write = (target: Uint8Array, index: number, sample: number) => {
    if (image.depth === 16) target[index * 2] = sample >>> 8;
    target[index * bytesPerSample + bytesPerSample - 1] = sample & 255;
  };
  let transparent = false;
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    for (let channel = 0; channel < components; channel++)
      write(
        color,
        pixel * components + channel,
        image.data[pixel * image.channels + channel]
      );
    if (alpha) {
      const sample = image.data[pixel * image.channels + components];
      write(alpha, pixel, sample);
      if (sample < (image.depth === 16 ? 65535 : 255)) transparent = true;
    }
  }
  const base = {
    Type: "XObject",
    Subtype: "Image",
    Width: image.width,
    Height: image.height,
    BitsPerComponent: image.depth,
  };
  const mask =
    alpha && transparent
      ? pdf.context.register(
          pdf.context.flateStream(alpha, {
            ...base,
            ColorSpace: "DeviceGray",
            Decode: [0, 1],
          })
        )
      : undefined;
  return pdf.context.register(
    pdf.context.flateStream(color, {
      ...base,
      ColorSpace: pngSpace(pdf, image, components),
      SMask: mask,
    })
  );
}
