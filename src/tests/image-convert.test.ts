import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  createCanvas,
  ImageData,
  loadImage,
  type Image,
} from "@napi-rs/canvas";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { unzlibSync } from "fflate";
import JSZip from "jszip";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  convertImages,
  type ImageOutputFormat,
} from "../features/convert/lib/convertImages";
import { canvasBlob, rasterImage } from "../features/convert/lib/imageCanvas";
import {
  jpegProfile,
  jpegSegments,
  jpegWithProfile,
  pngBytes,
  pngChunks,
  profileChunk,
} from "../features/convert/lib/imageMetadata";
import { decodePngPixels, rgba8 } from "../features/convert/lib/imagePixels";
import {
  conversionStem,
  detectSources,
  displayedSize,
  IMAGE_INPUT_LIMITS,
  inspectImageBytes,
} from "../features/convert/lib/imageSource";

const encodings: { type: string; quality: number }[] = [];
const closed: ReturnType<typeof vi.fn>[] = [];
const require = createRequire(import.meta.url);
let webpDecoder: Awaited<
  ReturnType<(typeof import("@jsquash/webp/codec/dec/webp_dec.js"))["default"]>
>;
async function rawWebp(blob: Blob) {
  if (!webpDecoder) {
    const { default: factory } =
      await import("@jsquash/webp/codec/dec/webp_dec.js");
    webpDecoder = await factory({
      wasmBinary: await readFile(
        require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm")
      ),
    });
  }
  return webpDecoder.decode(await blob.arrayBuffer())!;
}
beforeEach(() => {
  vi.stubGlobal("ImageData", ImageData);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const filename = url.split("/").pop()!.split("?")[0];
      const path = filename.startsWith("mozjpeg_")
        ? `@jsquash/jpeg/codec/${filename.includes("_dec") ? "dec" : "enc"}/${filename}`
        : `@jsquash/webp/codec/enc/${filename}`;
      return new Response(await readFile(require.resolve(path)));
    })
  );
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = createCanvas(1, 1);
      // The native canvas uses `mime`, while browser OffscreenCanvas uses `type`.
      Object.defineProperty(canvas, "convertToBlob", {
        value: ({ type, quality }: { type: string; quality: number }) =>
          new Promise<Blob | null>((resolve) => {
            encodings.push({ type, quality });
            canvas.toBlob(resolve, type, quality);
          }),
      });

      return canvas;
    },
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (file: File) => {
      const image = (await loadImage(
        Buffer.from(await file.arrayBuffer())
      )) as Image & { close: () => void };
      image.close = vi.fn();
      closed.push(image.close as ReturnType<typeof vi.fn>);
      return image;
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  encodings.length = 0;
  closed.length = 0;
});

function picture(
  format: "png" | "jpg" = "png",
  name = `photo.${format}`,
  transparent = false
) {
  const canvas = createCanvas(80, 40);
  const ctx = canvas.getContext("2d");
  if (!transparent) {
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 40, 20);
    ctx.fillStyle = "#0f0";
    ctx.fillRect(40, 0, 40, 20);
    ctx.fillStyle = "#00f";
    ctx.fillRect(0, 20, 40, 20);
    ctx.fillStyle = "#ff0";
    ctx.fillRect(40, 20, 40, 20);
  } else {
    ctx.fillStyle = "#f00";
    ctx.fillRect(20, 10, 40, 20);
  }
  return new File(
    [
      new Uint8Array(
        format === "png"
          ? canvas.toBuffer("image/png")
          : canvas.toBuffer("image/jpeg")
      ),
    ],
    name,
    { type: format === "png" ? "image/png" : "image/jpeg" }
  );
}

async function withExif(orientation: number) {
  const original = await picture("jpg").arrayBuffer();
  const bytes = new Uint8Array(original),
    exif = new Uint8Array(36),
    view = new DataView(exif.buffer);
  exif.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73]);
  view.setUint16(12, 42, true);
  view.setUint32(14, 8, true);
  view.setUint16(18, 1, true);
  view.setUint16(20, 0x112, true);
  view.setUint16(22, 3, true);
  view.setUint32(24, 1, true);
  view.setUint16(28, orientation, true);
  return new File(
    [bytes.subarray(0, 2), exif, bytes.subarray(2)],
    `orientation-${orientation}.jpg`,
    { type: "image/jpeg" }
  );
}

async function decode(blob: Blob) {
  const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return { image, ctx };
}

async function decodeSvgImage(blob: Blob) {
  const svg = await blob.text();
  const [, width, height] = svg.match(/<svg[^>]+width="(\d+)" height="(\d+)"/)!;
  const [, embeddedWidth, embeddedHeight] = svg.match(
    /<image width="(\d+)" height="(\d+)"/
  )!;
  const matrix = svg
    .match(/transform="matrix\(([^)]+)\)"/)![1]
    .split(" ")
    .map(Number);
  const embedded = await loadImage(
    Buffer.from(svg.match(/base64,([^\"]+)/)![1], "base64")
  );
  const canvas = createCanvas(Number(width), Number(height));
  const ctx = canvas.getContext("2d");
  ctx.transform(
    ...(matrix as [number, number, number, number, number, number])
  );
  ctx.drawImage(embedded, 0, 0, Number(embeddedWidth), Number(embeddedHeight));
  return { image: { width: Number(width), height: Number(height) }, ctx };
}

describe("automatic source detection", () => {
  it("uses file signatures rather than filename or MIME type", async () => {
    const file = new File([await picture().arrayBuffer()], "wrong.PDF", {
      type: "application/pdf",
    });
    expect(await detectSources([file, picture("jpg")])).toBe("images");
    expect(
      await detectSources([new File(["%PDF-1.7\n"], "no-extension")])
    ).toBe("pdf");
  });
  it("rejects mixed batches, multiple PDFs and unsupported content without silently ignoring files", async () => {
    const pdf = new File(["%PDF-1.7"], "a.pdf");
    await expect(detectSources([pdf, picture()])).rejects.toThrow("分開");
    await expect(detectSources([pdf, pdf])).rejects.toThrow("一份");
    await expect(
      detectSources([new File(["not an image"], "fake.png")])
    ).rejects.toThrow("格式不支援");
    await expect(detectSources([new File([], "empty.jpg")])).rejects.toThrow(
      "空的"
    );
  });
  it("rejects excessive batches before reading the files", async () => {
    await expect(
      detectSources(Array.from({ length: 101 }, () => picture()))
    ).rejects.toThrow("100");
  });
  it("reads image dimensions and rejects oversized or malformed image headers before decode", async () => {
    const bytes = new Uint8Array(await picture().arrayBuffer());
    expect(inspectImageBytes(bytes)).toEqual({
      format: "png",
      width: 80,
      height: 40,
      orientation: 1,
    });
    new DataView(bytes.buffer).setUint32(16, 20000);
    expect(() => inspectImageBytes(bytes)).toThrow("尺寸超過");
    expect(() =>
      inspectImageBytes(new Uint8Array([255, 216, 255, 225, 0, 255]))
    ).toThrow("無法讀取");
  });
});

describe("image outputs", () => {
  it.each(["jpg", "png"] as const)(
    "preserves original %s bytes when no rotation is needed",
    async (format) => {
      const file = picture(format);
      const result = await convertImages([{ file, rotation: 0 }], {
        format,
        outputName: "result",
      });
      expect(result.filename).toBe(`result.${format}`);
      expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(
        new Uint8Array(await file.arrayBuffer())
      );
      expect(createImageBitmap).not.toHaveBeenCalled();
    }
  );
  it("encodes JPG at maximum quality with a white background and full chroma sampling", async () => {
    const file = picture("png", "transparent.png", true);
    const result = await convertImages([{ file, rotation: 90 }], {
      format: "jpg",
      outputName: "white",
    });
    const { image, ctx } = await decode(result.blob);
    expect([image.width, image.height]).toEqual([40, 80]);
    expect([...ctx.getImageData(1, 1, 1, 1).data]).toEqual([
      255, 255, 255, 255,
    ]);
    expect(createImageBitmap).not.toHaveBeenCalled();
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    for (let at = 2; at + 4 < bytes.length;) {
      const marker = bytes[at + 1];
      const length = new DataView(bytes.buffer).getUint16(at + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        expect(bytes[at + 9]).toBe(3);
        expect([bytes[at + 11], bytes[at + 14], bytes[at + 17]]).toEqual([
          0x11, 0x11, 0x11,
        ]);
        break;
      }
      at += length + 2;
    }
  });
  it.each(["png", "webp"] as const)(
    "preserves dimensions and transparency in %s",
    async (format) => {
      const result = await convertImages(
        [{ file: picture("png", "transparent.png", true), rotation: 270 }],
        { format, outputName: "alpha" }
      );
      expect(result.blob.type).toBe(`image/${format}`);
      const { image, ctx } = await decode(result.blob);
      expect([image.width, image.height]).toEqual([40, 80]);
      expect(ctx.getImageData(1, 1, 1, 1).data[3]).toBe(0);
      expect(ctx.getImageData(20, 40, 1, 1).data[3]).toBe(255);
    }
  );
  it("rejects a browser encoder fallback instead of downloading PNG bytes as WEBP", async () => {
    const fake = {
      toBlob: (callback: BlobCallback) =>
        callback(new Blob(["png"], { type: "image/png" })),
    } as HTMLCanvasElement;
    await expect(canvasBlob(fake, "image/webp")).rejects.toThrow("WEBP");
  });
  it("produces a self-contained SVG with original embedded bytes and no external resources", async () => {
    const file = picture("png", "<script>.png", true);
    const result = await convertImages([{ file, rotation: 0 }], {
      format: "svg",
      outputName: "<script>.svg",
    });
    expect(result.filename).toBe("_script_.svg");
    expect(result.blob.type).toBe("image/svg+xml");
    const text = await result.blob.text();
    expect(text).toContain('viewBox="0 0 80 40"');
    expect(text).not.toContain("<script>");
    const base64 = text.match(/base64,([^\"]+)/)![1];
    expect(Buffer.from(base64, "base64")).toEqual(
      Buffer.from(await file.arrayBuffer())
    );
  });
  it("rotates SVG using a transform without re-encoding the embedded source", async () => {
    const file = picture("png", "a.png", true);
    const result = await convertImages([{ file, rotation: 90 }], {
      format: "svg",
      outputName: "rotated",
    });
    const text = await result.blob.text();
    expect(text).toContain('viewBox="0 0 40 80"');
    expect(text).toContain('transform="matrix(0 1 -1 0 40 0)"');
    expect(Buffer.from(text.match(/base64,([^\"]+)/)![1], "base64")).toEqual(
      Buffer.from(await file.arrayBuffer())
    );
    const { image, ctx } = await decodeSvgImage(result.blob);
    expect([image.width, image.height]).toEqual([40, 80]);
    expect(ctx.getImageData(1, 1, 1, 1).data[3]).toBe(0);
    expect(ctx.getImageData(20, 40, 1, 1).data[3]).toBe(255);
  });
  it.each(["jpg", "png", "svg", "webp"] as ImageOutputFormat[])(
    "packages %s outputs in supplied order with collision-free names",
    async (format) => {
      const result = await convertImages(
        [
          { file: picture("jpg", "same.jpg"), rotation: 0 },
          { file: picture("png", "same.jpg"), rotation: 90 },
        ],
        { format, outputName: "album.zip" }
      );
      expect(result.filename).toBe("album.zip");
      expect(result.fileCount).toBe(2);
      const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
      expect(Object.keys(zip.files)).toEqual([
        `album-01.${format}`,
        `album-02.${format}`,
      ]);
      if (format !== "svg") {
        const first = await decode(
          new Blob([
            new Uint8Array(
              await zip.file(`album-01.${format}`)!.async("uint8array")
            ),
          ])
        );
        const second = await decode(
          new Blob([
            new Uint8Array(
              await zip.file(`album-02.${format}`)!.async("uint8array")
            ),
          ])
        );
        expect([first.image.width, first.image.height]).toEqual([80, 40]);
        expect([second.image.width, second.image.height]).toEqual([40, 80]);
      }
    }
  );
});

describe("images to PDF", () => {
  it("creates one page per image in order, preserving source pixels and original JPEG stream", async () => {
    const jpg = picture("jpg");
    const result = await convertImages(
      [
        { file: jpg, rotation: 0 },
        { file: picture(), rotation: 90 },
      ],
      { format: "pdf", outputName: "album" }
    );
    expect(result.filename).toBe("album.pdf");
    expect(result.blob.type).toBe("application/pdf");
    expect(result.fileCount).toBe(1);
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(
      pdf.getPages().map((page) => [page.getWidth(), page.getHeight()])
    ).toEqual([
      [19.2, 9.6],
      [9.6, 19.2],
    ]);
    const streams = pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object)
      .filter((object) => object instanceof PDFRawStream);
    const original = Buffer.from(await jpg.arrayBuffer());
    expect(
      streams.some((stream) =>
        Buffer.from(stream.getContents()).equals(original)
      )
    ).toBe(true);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "renders EXIF orientation %s and user rotation consistently with the native image decoder",
    async (orientation) => {
      const file = await withExif(orientation);
      const info = inspectImageBytes(new Uint8Array(await file.arrayBuffer()));
      expect(info.orientation).toBe(orientation);
      for (const rotation of [0, 90]) {
        const result = await convertImages([{ file, rotation }], {
          format: "pdf",
          outputName: "oriented",
        });
        const task = getDocument({
          data: new Uint8Array(await result.blob.arrayBuffer()),
        });
        try {
          const pdf = await task.promise;
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 300 / 72 });
          const size = displayedSize(info, rotation);
          expect([
            Math.round(viewport.width),
            Math.round(viewport.height),
          ]).toEqual([size.width, size.height]);
          const canvas = createCanvas(size.width, size.height),
            ctx = canvas.getContext("2d");
          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: ctx as unknown as CanvasRenderingContext2D,
            viewport,
          }).promise;
          const reference = await decode(
            (
              await convertImages([{ file, rotation }], {
                format: "png",
                outputName: "reference",
              })
            ).blob
          );
          for (const [x, y] of [
            [size.width / 4, size.height / 4],
            [(size.width * 3) / 4, size.height / 4],
            [size.width / 4, (size.height * 3) / 4],
            [(size.width * 3) / 4, (size.height * 3) / 4],
          ]) {
            const actual = ctx.getImageData(x, y, 1, 1).data,
              expected = reference.ctx.getImageData(x, y, 1, 1).data;
            for (let channel = 0; channel < 3; channel++)
              expect(
                Math.abs(actual[channel] - expected[channel])
              ).toBeLessThan(8);
          }
        } finally {
          await task.destroy();
        }
      }
    }
  );
});

describe("conversion cancellation and limits", () => {
  it("honors cancellation before work and between images", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      convertImages([{ file: picture(), rotation: 0 }], {
        format: "jpg",
        outputName: "a",
        signal: abort.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    const second = new AbortController();
    let progress = 0;
    await expect(
      convertImages(
        [
          { file: picture(), rotation: 0 },
          { file: picture(), rotation: 0 },
        ],
        {
          format: "png",
          outputName: "a",
          signal: second.signal,
          onProgress: () => {
            progress++;
            second.abort();
          },
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toBe(1);
  });
  it("cancels ZIP packing without returning a partial download", async () => {
    const abort = new AbortController();
    await expect(
      convertImages(
        [
          { file: picture(), rotation: 0 },
          { file: picture(), rotation: 0 },
        ],
        {
          format: "png",
          outputName: "a",
          signal: abort.signal,
          onPackingProgress: () => abort.abort(),
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("enforces output size limits for images and PDF", async () => {
    const previous = IMAGE_INPUT_LIMITS.outputBytes;
    Object.defineProperty(IMAGE_INPUT_LIMITS, "outputBytes", {
      value: 10,
      configurable: true,
    });
    try {
      for (const format of ["png", "pdf"] as const)
        await expect(
          convertImages([{ file: picture(), rotation: 0 }], {
            format,
            outputName: "a",
          })
        ).rejects.toThrow("128 MB");
    } finally {
      Object.defineProperty(IMAGE_INPUT_LIMITS, "outputBytes", {
        value: previous,
        configurable: true,
      });
    }
  });
  it("validates rotation, output formats and names", async () => {
    await expect(
      convertImages([{ file: picture(), rotation: 45 }], {
        format: "png",
        outputName: "a",
      })
    ).rejects.toThrow("旋轉");
    await expect(
      convertImages([{ file: picture(), rotation: 0 }], {
        format: "gif" as ImageOutputFormat,
        outputName: "a",
      })
    ).rejects.toThrow("有效");
    expect(conversionStem("my:album.WEBP")).toBe("my_album");
    expect(conversionStem("   ")).toBe("document");
  });
});

describe("original resolution and best quality", () => {
  function precisePng(depth: 8 | 16 = 8, channels = 4) {
    const samples =
      depth === 16
        ? new Uint16Array([
            1001, 2002, 3003, 0, 1002, 2003, 3004, 1, 65432, 54321, 43210,
            32768, 12000, 34000, 56000, 65535,
          ])
        : new Uint8Array([
            123, 45, 67, 0, 8, 99, 201, 1, 19, 202, 173, 128, 222, 111, 7, 255,
          ]);
    const data =
      channels === 2
        ? samples.filter((_, index) => index % 4 === 0 || index % 4 === 3)
        : samples;
    const bytes = new Uint8Array(
      encodePng({ width: 2, height: 2, depth, channels, data })
    );
    return {
      file: new File([bytes], "precise.png", { type: "image/png" }),
      bytes,
      data,
    };
  }
  function icc(space = "RGB ", length = 132) {
    const profile = new Uint8Array(length);
    new DataView(profile.buffer).setUint32(0, length);
    profile.set(new TextEncoder().encode(space), 16);
    profile.set(new TextEncoder().encode("acsp"), 36);
    return profile;
  }
  function taggedPng(bytes: Uint8Array, profile: Uint8Array) {
    const chunks = pngChunks(bytes);
    return pngBytes([chunks[0], profileChunk(profile), ...chunks.slice(1)]);
  }
  it.each([0, 90, 180, 270])(
    "WebP preserves every 8-bit RGBA sample, including hidden transparent colors, at rotation %s",
    async (rotation) => {
      const { file, data } = precisePng();
      const result = await convertImages([{ file, rotation }], {
        format: "webp",
        outputName: "lossless",
      });
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("VP8L");
      const decoded = await rawWebp(result.blob);
      const order =
        rotation === 90
          ? [2, 0, 3, 1]
          : rotation === 180
            ? [3, 2, 1, 0]
            : rotation === 270
              ? [1, 3, 0, 2]
              : [0, 1, 2, 3];
      expect([...decoded.data]).toEqual(
        order.flatMap((pixel) => [...data.subarray(pixel * 4, pixel * 4 + 4)])
      );
      expect(encodings).toEqual([]);
    }
  );
  it.each([2, 4])(
    "PNG rotation preserves 16-bit samples and alpha with %s channels",
    async (channels) => {
      const { file, data } = precisePng(16, channels);
      const result = await convertImages([{ file, rotation: 90 }], {
        format: "png",
        outputName: "16bit",
      });
      const decoded = decodePng(
        new Uint8Array(await result.blob.arrayBuffer()),
        { checkCrc: true }
      );
      expect([
        decoded.depth,
        decoded.channels,
        decoded.width,
        decoded.height,
      ]).toEqual([16, channels, 2, 2]);
      expect([...decoded.data]).toEqual(
        [2, 0, 3, 1].flatMap((pixel) => [
          ...data.subarray(pixel * channels, pixel * channels + channels),
        ])
      );
    }
  );
  it.each([2, 4])(
    "PDF embeds original 16-bit image and alpha samples with %s channels",
    async (channels) => {
      const { file, data } = precisePng(16, channels);
      const result = await convertImages([{ file, rotation: 90 }], {
        format: "pdf",
        outputName: "16bit",
      });
      const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
      const streams = pdf.context
        .enumerateIndirectObjects()
        .map(([, object]) => object)
        .filter(
          (object): object is PDFRawStream =>
            object instanceof PDFRawStream &&
            object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image"
        );
      expect(streams).toHaveLength(2);
      for (const stream of streams)
        expect(
          stream.dict.get(PDFName.of("BitsPerComponent"))?.toString()
        ).toBe("16");
      const colors = streams.find((stream) =>
        stream.dict.has(PDFName.of("SMask"))
      )!;
      const mask = streams.find(
        (stream) => !stream.dict.has(PDFName.of("SMask"))
      )!;
      const toBytes = (samples: number[]) =>
        samples.flatMap((sample) => [sample >>> 8, sample & 255]);
      expect([...unzlibSync(colors.getContents())]).toEqual(
        toBytes(
          [...data].filter((_, index) => index % channels !== channels - 1)
        )
      );
      expect([...unzlibSync(mask.getContents())]).toEqual(
        toBytes(
          [...data].filter((_, index) => index % channels === channels - 1)
        )
      );
    }
  );
  it("keeps SVG's embedded 16-bit PNG unchanged even after rotation", async () => {
    const { file, bytes } = precisePng(16);
    const result = await convertImages([{ file, rotation: 270 }], {
      format: "svg",
      outputName: "16bit",
    });
    const svg = await result.blob.text();
    expect(Buffer.from(svg.match(/base64,([^\"]+)/)![1], "base64")).toEqual(
      Buffer.from(bytes)
    );
    expect(svg).toContain('transform="matrix(0 -1 1 0 0 2)"');
  });
  it("preserves ICC profiles through PNG rotation, WebP lossless, JPG encoding and PDF embedding", async () => {
    const { bytes } = precisePng();
    const profile = icc();
    const file = new File([taggedPng(bytes, profile)], "profile.png", {
      type: "image/png",
    });
    for (const format of ["png", "webp", "jpg", "pdf"] as const) {
      const result = await convertImages([{ file, rotation: 90 }], {
        format,
        outputName: "profile",
      });
      const output = new Uint8Array(await result.blob.arrayBuffer());
      if (format === "png")
        expect(decodePng(output).iccEmbeddedProfile?.profile).toEqual(profile);
      else if (format === "jpg") expect(jpegProfile(output)).toEqual(profile);
      else if (format === "webp") {
        expect(new TextDecoder().decode(output.subarray(12, 16))).toBe("VP8X");
        expect(output[20] & 0x30).toBe(0x30);
        expect(new TextDecoder().decode(output.subarray(30, 34))).toBe("ICCP");
        expect(output.subarray(38, 38 + profile.length)).toEqual(profile);
        expect((await rawWebp(result.blob)).width).toBe(2);
      } else {
        const pdf = await PDFDocument.load(output);
        const streams = pdf.context
          .enumerateIndirectObjects()
          .map(([, object]) => object)
          .filter((object) => object instanceof PDFRawStream);
        expect(
          streams.some(
            (stream) =>
              stream.dict.get(PDFName.of("N"))?.toString() === "3" &&
              Buffer.from(unzlibSync(stream.getContents())).equals(
                Buffer.from(profile)
              )
          )
        ).toBe(true);
        expect(
          streams.some((stream) =>
            stream.dict
              .get(PDFName.of("ColorSpace"))
              ?.toString()
              .includes("ICCBased")
          )
        ).toBe(true);
      }
    }
  });
  it("preserves split JPEG ICC data and carries it to PNG and PDF", async () => {
    const profile = icc("RGB ", 70000);
    const bytes = jpegWithProfile(
      new Uint8Array(await picture("jpg").arrayBuffer()),
      profile
    );
    expect(jpegProfile(bytes)).toEqual(profile);
    const file = new File([bytes], "profile.jpg", { type: "image/jpeg" });
    const result = await convertImages([{ file, rotation: 90 }], {
      format: "png",
      outputName: "profile",
    });
    expect(
      decodePng(new Uint8Array(await result.blob.arrayBuffer()))
        .iccEmbeddedProfile?.profile
    ).toEqual(profile);
    const pdfResult = await convertImages([{ file, rotation: 0 }], {
      format: "pdf",
      outputName: "profile",
    });
    const pdf = await PDFDocument.load(await pdfResult.blob.arrayBuffer());
    expect(
      pdf.context
        .enumerateIndirectObjects()
        .some(
          ([, object]) =>
            object instanceof PDFRawStream &&
            object.dict
              .get(PDFName.of("ColorSpace"))
              ?.toString()
              .includes("ICCBased")
        )
    ).toBe(true);
  });
  it("uses minimum JPEG quantization and 4:4:4 sampling for color detail", async () => {
    const result = await convertImages([{ file: picture(), rotation: 0 }], {
      format: "jpg",
      outputName: "detail",
    });
    const segments = jpegSegments(
      new Uint8Array(await result.blob.arrayBuffer())
    );
    const frame = segments.find(
      ({ marker }) => marker === 0xc0 || marker === 0xc2
    )!;
    expect([frame.data[7], frame.data[10], frame.data[13]]).toEqual([
      17, 17, 17,
    ]);
    const tables = segments.filter(({ marker }) => marker === 0xdb);
    expect(tables.length).toBeGreaterThan(0);
    for (const { data } of tables)
      expect([...data.subarray(1)]).toEqual(Array(data.length - 1).fill(1));
  });
  it("exports original dimensions independently of the 720px thumbnail", async () => {
    const data = new Uint8Array(1600 * 900 * 3).fill(120);
    const file = new File(
      [
        new Uint8Array(
          encodePng({ width: 1600, height: 900, channels: 3, data })
        ),
      ],
      "large.png",
      { type: "image/png" }
    );
    const info = inspectImageBytes(new Uint8Array(await file.arrayBuffer()));
    const thumb = await rasterImage(
      file,
      info,
      90,
      "image/png",
      undefined,
      720
    );
    expect(decodePng(new Uint8Array(await thumb.arrayBuffer())).height).toBe(
      720
    );
    const result = await convertImages([{ file, rotation: 90 }], {
      format: "png",
      outputName: "full",
    });
    const output = decodePng(new Uint8Array(await result.blob.arrayBuffer()));
    expect([output.width, output.height]).toEqual([900, 1600]);
  });
  it("maps 16-bit source to WebP's 8-bit range without resizing", async () => {
    const { file, bytes } = precisePng(16);
    const result = await convertImages([{ file, rotation: 0 }], {
      format: "webp",
      outputName: "8bit",
    });
    const output = await rawWebp(result.blob);
    expect([output.width, output.height]).toEqual([2, 2]);
    expect([...output.data]).toEqual([...rgba8(decodePngPixels(bytes)).data]);
  });
  it("rejects WebP dimensions beyond its format limit without reducing resolution", async () => {
    const file = new File(
      [
        new Uint8Array(
          encodePng({
            width: 16384,
            height: 1,
            channels: 1,
            data: new Uint8Array(16384),
          })
        ),
      ],
      "wide.png",
      { type: "image/png" }
    );
    await expect(
      convertImages([{ file, rotation: 0 }], {
        format: "webp",
        outputName: "wide",
      })
    ).rejects.toThrow("16,383");
  });
  it("rejects animated PNG and malformed CRC instead of silently dropping image data", async () => {
    const { bytes } = precisePng();
    const chunks = pngChunks(bytes);
    const animated = new File(
      [
        pngBytes([
          chunks[0],
          { type: "acTL", data: new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0]) },
          ...chunks.slice(1),
        ]),
      ],
      "animated.png"
    );
    await expect(
      convertImages([{ file: animated, rotation: 0 }], {
        format: "webp",
        outputName: "a",
      })
    ).rejects.toThrow("靜態 PNG");
    bytes[bytes.length - 1] ^= 1;
    await expect(
      convertImages([{ file: new File([bytes], "broken.png"), rotation: 90 }], {
        format: "png",
        outputName: "a",
      })
    ).rejects.toThrow("內容損壞");
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "SVG displays EXIF orientation %s and manual rotation using the original JPEG data",
    async (orientation) => {
      const file = await withExif(orientation);
      const result = await convertImages([{ file, rotation: 90 }], {
        format: "svg",
        outputName: "oriented",
      });
      const reference = await convertImages([{ file, rotation: 90 }], {
        format: "png",
        outputName: "reference",
      });
      const actual = await decodeSvgImage(result.blob);
      const expected = await decode(reference.blob);
      expect([actual.image.width, actual.image.height]).toEqual([
        expected.image.width,
        expected.image.height,
      ]);
      for (const [x, y] of [
        [actual.image.width / 4, actual.image.height / 4],
        [(actual.image.width * 3) / 4, (actual.image.height * 3) / 4],
      ]) {
        const a = actual.ctx.getImageData(x, y, 1, 1).data;
        const b = expected.ctx.getImageData(x, y, 1, 1).data;
        for (let channel = 0; channel < 4; channel++)
          expect(Math.abs(a[channel] - b[channel])).toBeLessThan(8);
      }
    }
  );
});
