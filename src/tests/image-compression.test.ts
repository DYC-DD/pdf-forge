import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { decode, encode } from "fast-png";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  compressImage,
  HIGH_IMAGE_MAX_EDGE,
} from "../features/compress/lib/compressImage";
import { detectCompressionSource } from "../features/compress/lib/compressionSource";
import { pngBytes, pngChunks } from "../features/convert/lib/imageMetadata";
import {
  IMAGE_INPUT_LIMITS,
  inspectImageBytes,
} from "../features/convert/lib/imageSource";

const require = createRequire(import.meta.url);
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const filename = url.split("/").pop()!.split("?")[0];
      return new Response(
        await readFile(
          require.resolve(
            `@jsquash/jpeg/codec/${filename.includes("_dec") ? "dec" : "enc"}/${filename}`
          )
        )
      );
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

function png(width = 120, height = 60, depth: 8 | 16 = 8, channels = 4) {
  const data =
    depth === 16
      ? new Uint16Array(width * height * channels)
      : new Uint8Array(width * height * channels);
  const max = depth === 16 ? 65535 : 255;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      for (let c = 0; c < channels; c++)
        data[at + c] = (x * 13 + y * 7 + c * 29) % max;
      if (channels === 2 || channels === 4)
        data[at + channels - 1] = x < width / 2 ? 0 : max;
    }
  return new File(
    [
      new Uint8Array(
        encode({ width, height, depth, channels, data }, { zlib: { level: 0 } })
      ),
    ],
    "picture.png",
    { type: "image/png" }
  );
}
function jpeg(width = 120, height = 60) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "red");
  gradient.addColorStop(0.5, "green");
  gradient.addColorStop(1, "blue");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  return new File(
    [new Uint8Array(canvas.toBuffer("image/jpeg", 100))],
    "photo.jpeg",
    { type: "image/jpeg" }
  );
}
async function orientedJpeg() {
  const bytes = new Uint8Array(await jpeg().arrayBuffer());
  const exif = new Uint8Array(36),
    view = new DataView(exif.buffer);
  exif.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73]);
  view.setUint16(12, 42, true);
  view.setUint32(14, 8, true);
  view.setUint16(18, 1, true);
  view.setUint16(20, 0x112, true);
  view.setUint16(22, 3, true);
  view.setUint32(24, 1, true);
  view.setUint16(28, 6, true);
  return new File(
    [bytes.subarray(0, 2), exif, bytes.subarray(2)],
    "rotated.jpg",
    { type: "image/jpeg" }
  );
}

describe("compression intake", () => {
  it("rejects multiple files before reading any of them", async () => {
    const file = jpeg();
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(detectCompressionSource([file, png()])).rejects.toThrow(
      "一次只能加入一個"
    );
    await expect(
      detectCompressionSource([file, new File(["%PDF-1.7"], "a.pdf")])
    ).rejects.toThrow("一次只能加入一個");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["jpg", "png"] as const)(
    "identifies %s by content and normalizes its MIME",
    async (format) => {
      const file = format === "jpg" ? jpeg() : png();
      const source = await detectCompressionSource([
        new File([file], "wrong.pdf", { type: "application/pdf" }),
      ]);
      expect(source.kind).toBe("image");
      expect(source.file.type).toBe(
        format === "jpg" ? "image/jpeg" : "image/png"
      );
      if (source.kind === "image") expect(source.info.format).toBe(format);
    }
  );
  it("recognizes a PDF without a PDF extension", async () => {
    const source = await detectCompressionSource([
      new File(["%PDF-1.7\n"], "document.jpg"),
    ]);
    expect(source.kind).toBe("pdf");
    expect(source.file.name).toBe("document.jpg.pdf");
  });
  it("rejects unsupported, empty and oversized files", async () => {
    await expect(
      detectCompressionSource([new File(["GIF89a"], "photo.gif")])
    ).rejects.toThrow("格式不支援");
    await expect(
      detectCompressionSource([new File([], "empty.jpg")])
    ).rejects.toThrow("空的");
    const large = jpeg();
    Object.defineProperty(large, "size", {
      value: IMAGE_INPUT_LIMITS.fileBytes + 1,
    });
    await expect(detectCompressionSource([large])).rejects.toThrow("64 MB");
  });
  it("rejects animated PNG before switching into image mode", async () => {
    const chunks = pngChunks(new Uint8Array(await png().arrayBuffer()));
    const animation = { type: "acTL", data: new Uint8Array(8) };
    await expect(
      detectCompressionSource([
        new File(
          [pngBytes([chunks[0], animation, ...chunks.slice(1)])],
          "animated.png"
        ),
      ])
    ).rejects.toThrow("動態 PNG");
  });
});

describe("image compression", () => {
  it.each([8, 16] as const)(
    "losslessly compresses %i-bit PNG and preserves transparent pixel colors",
    async (depth) => {
      const file = png(120, 60, depth);
      const original = decode(new Uint8Array(await file.arrayBuffer()));
      const result = await compressImage(file, "medium");
      const output = decode(new Uint8Array(await result.blob.arrayBuffer()));
      expect(result.blob.type).toBe("image/png");
      expect(result.blob.size).toBeLessThan(file.size);
      expect([
        output.width,
        output.height,
        output.depth,
        output.channels,
      ]).toEqual([120, 60, depth, 4]);
      expect(output.data).toEqual(original.data);
    }
  );
  it.each([1, 2, 3])(
    "preserves PNG with %i color channels",
    async (channels) => {
      const file = png(30, 20, 16, channels);
      const result = await compressImage(file, "medium");
      const original = decode(new Uint8Array(await file.arrayBuffer()));
      const output = decode(new Uint8Array(await result.blob.arrayBuffer()));
      expect(output.channels).toBe(channels);
      expect(output.data).toEqual(original.data);
    }
  );
  it("low compression removes PNG text while keeping the original pixel stream", async () => {
    const chunks = pngChunks(new Uint8Array(await png().arrayBuffer()));
    const text = {
      type: "tEXt",
      data: new TextEncoder().encode(`Comment\0${"note".repeat(2000)}`),
    };
    const file = new File(
      [pngBytes([chunks[0], text, ...chunks.slice(1)])],
      "notes.png",
      { type: "image/png" }
    );
    const result = await compressImage(file, "low");
    expect(result.blob.size).toBeLessThan(file.size);
    expect(pngChunks(new Uint8Array(await result.blob.arrayBuffer()))).toEqual(
      chunks
    );
  });
  it("retains PNG color information during optimization", async () => {
    const chunks = pngChunks(new Uint8Array(await png().arrayBuffer()));
    const gamma = { type: "gAMA", data: new Uint8Array([0, 0, 177, 143]) };
    const file = new File(
      [pngBytes([chunks[0], gamma, ...chunks.slice(1)])],
      "gamma.png"
    );
    const result = await compressImage(file, "medium");
    expect(
      pngChunks(new Uint8Array(await result.blob.arrayBuffer()))
    ).toContainEqual(gamma);
  });
  it("compresses JPEG at the original resolution and preserves its displayed orientation", async () => {
    const file = await orientedJpeg();
    const result = await compressImage(file, "medium");
    expect(result.blob.type).toBe("image/jpeg");
    expect(result.blob.size).toBeLessThan(file.size);
    const output = await loadImage(
      Buffer.from(await result.blob.arrayBuffer())
    );
    expect([output.width, output.height]).toEqual([60, 120]);
    expect(
      inspectImageBytes(new Uint8Array(await result.blob.arrayBuffer()))
        .orientation
    ).toBe(1);
    const canvas = createCanvas(60, 120),
      context = canvas.getContext("2d");
    context.drawImage(output, 0, 0);
    const start = context.getImageData(55, 5, 1, 1).data;
    const end = context.getImageData(5, 115, 1, 1).data;
    expect(start[0]).toBeGreaterThan(start[2]);
    expect(end[2]).toBeGreaterThan(end[0]);
  });
  it("low JPEG compression keeps EXIF direction intact", async () => {
    const file = await orientedJpeg();
    const result = await compressImage(file, "low");
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer())
    );
  });
  it.each(["jpg", "png"] as const)(
    "high compression caps %s dimensions and keeps the aspect ratio",
    async (format) => {
      const file = format === "jpg" ? jpeg(2400, 1200) : png(2400, 1200);
      const result = await compressImage(file, "high");
      const info = inspectImageBytes(
        new Uint8Array(await result.blob.arrayBuffer())
      );
      expect([info.width, info.height]).toEqual([
        HIGH_IMAGE_MAX_EDGE,
        HIGH_IMAGE_MAX_EDGE / 2,
      ]);
      expect(result.blob.size).toBeLessThan(file.size);
      if (format === "png") {
        const output = decode(new Uint8Array(await result.blob.arrayBuffer()));
        expect(output.channels).toBe(4);
        expect(output.data[3]).toBe(0);
        expect(output.data[output.data.length - 1]).toBe(255);
      }
    }
  );
  it.each(["jpg", "png"] as const)(
    "never enlarges small %s images or returns a larger file",
    async (format) => {
      const file = format === "jpg" ? jpeg(20, 10) : png(20, 10);
      const result = await compressImage(file, "high");
      const info = inspectImageBytes(
        new Uint8Array(await result.blob.arrayBuffer())
      );
      expect([info.width, info.height]).toEqual([20, 10]);
      expect(result.blob.size).toBeLessThanOrEqual(file.size);
    }
  );
  it("returns the original when no candidate is smaller", async () => {
    const first = await compressImage(png(), "medium");
    const file = new File([first.blob], "optimized.png", { type: "image/png" });
    const result = await compressImage(file, "medium");
    expect(result.blob).toBe(file);
  });
  it("rejects oversized dimensions and cancellation before encoding", async () => {
    const bytes = new Uint8Array(await png().arrayBuffer());
    new DataView(bytes.buffer).setUint32(16, 20000);
    await expect(
      compressImage(new File([bytes], "oversized.png"), "medium")
    ).rejects.toThrow("尺寸超過");
    const abort = new AbortController();
    abort.abort();
    await expect(
      compressImage(png(), "high", abort.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
