import { readFileSync } from "node:fs";

import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { afterEach, expect, it, vi } from "vitest";

import {
  compressPdfBytes,
  compressPdfWithDetails,
} from "../features/compress/lib/compressPdfBytes";
import {
  createImageBudget,
  imagePixels,
  jpegDimensions,
  qpdfImagePixels,
} from "../features/compress/lib/imageResources";
import { recompressJpegImages } from "../features/compress/lib/recompressImages";
import { COMPRESSION_LIMITS, PDF_LIMITS } from "../shared/pdf/limits";

const wasmPath = new URL(
  "../../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm",
  import.meta.url
).pathname;
const sourceJpeg = readFileSync(
  new URL("./fixtures/source.jpg", import.meta.url)
);
const mediumJpeg = readFileSync(
  new URL("./fixtures/medium.jpg", import.meta.url)
);

afterEach(() => vi.unstubAllGlobals());

async function imagePdf(
  count = 1,
  dimensions?: [number, number],
  jpeg: Uint8Array = sourceJpeg
) {
  const document = await PDFDocument.create();
  const page = document.addPage();
  for (let index = 0; index < count; index += 1) {
    const image = await document.embedJpg(jpeg);
    page.drawImage(image, { width: 100, height: 100 });
  }
  await document.flush();
  if (dimensions)
    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image"
      ) {
        object.dict.set(PDFName.of("Width"), PDFNumber.of(dimensions[0]));
        object.dict.set(PDFName.of("Height"), PDFNumber.of(dimensions[1]));
      }
    }
  return new Uint8Array(await document.save());
}

function fakeDecoder(fail = false) {
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 2200, height: 2200, close }));
  const canvases: { width: number; height: number }[] = [];
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        canvases.push(this);
      }
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob() {
        if (fail) throw new Error("encode failed");
        return new Blob([mediumJpeg], { type: "image/jpeg" });
      }
    }
  );
  return { decode, close, canvases };
}

it("enforces byte limits even when called without the UI or Worker wrapper", async () => {
  await expect(
    compressPdfBytes(new Uint8Array(), "low", wasmPath)
  ).rejects.toThrow("空的");
  const input = new Uint8Array(PDF_LIMITS.fileBytes + 1);
  await expect(compressPdfBytes(input, "high", wasmPath)).rejects.toThrow(
    "64 MB"
  );
});

it("checks the actual page count before compression in every mode", async () => {
  const document = await PDFDocument.create();
  for (let page = 0; page <= PDF_LIMITS.pagesPerFile; page += 1)
    document.addPage([100, 100]);
  const input = new Uint8Array(await document.save());
  for (const mode of ["low", "medium", "high"] as const) {
    await expect(compressPdfBytes(input, mode, wasmPath)).rejects.toThrow(
      "600 頁"
    );
  }
});

it.each([
  [0, 100],
  [-1, 100],
  [Infinity, 100],
  [1.5, 100],
  [8193, 1],
  [4001, 4000],
])("rejects unsafe image dimensions %s × %s", (width, height) => {
  expect(imagePixels(width, height)).toBeNull();
});

it("accepts images exactly at the per-image pixel and edge limits", () => {
  expect(imagePixels(4000, 4000)).toBe(COMPRESSION_LIMITS.imagePixels);
  expect(imagePixels(COMPRESSION_LIMITS.imageEdge, 1)).toBe(
    COMPRESSION_LIMITS.imageEdge
  );
});

it.each([
  [5000, 5000],
  [100, 100],
  [-1, 2200],
])(
  "skips oversized or misleading image dictionaries before decoding (%s × %s)",
  async (width, height) => {
    const { decode } = fakeDecoder();
    const input = await imagePdf(1, [width, height]);
    expect(await qpdfImagePixels(input)).toBeNull();
    expect(await recompressJpegImages(input, "high")).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    const result = await compressPdfWithDetails(input, "high", wasmPath);
    expect(result.appliedMode).toBe("low");
    expect(decode).not.toHaveBeenCalled();
  }
);

it("checks JPEG frame dimensions independently of the PDF dictionary", async () => {
  const header = jpegDimensions(sourceJpeg)!;
  expect(header).toEqual({ width: 2200, height: 2200 });
  expect(jpegDimensions(sourceJpeg.subarray(0, 30))).toBeNull();
  const bomb = new Uint8Array(sourceJpeg);
  // Find the SOF segment of the fixture and make its decoded dimensions huge.
  const frame = bomb.findIndex(
    (value, index) =>
      value === 0xff && [0xc0, 0xc1, 0xc2].includes(bomb[index + 1])
  );
  expect(frame).toBeGreaterThan(0);
  bomb[frame + 5] = 0xff;
  bomb[frame + 6] = 0xff;
  bomb[frame + 7] = 0xff;
  bomb[frame + 8] = 0xff;
  const { decode } = fakeDecoder();
  const input = await imagePdf(1, [2200, 2200], bomb);
  expect(await recompressJpegImages(input, "medium")).toBeNull();
  expect(await qpdfImagePixels(input)).toBeNull();
  expect(decode).not.toHaveBeenCalled();
});

it("shares the total decoding budget across both quality passes", async () => {
  const { decode, close, canvases } = fakeDecoder();
  const input = await imagePdf(3);
  const pixels = 2200 * 2200;
  const budget = { remainingPixels: 2 * pixels };
  expect(await recompressJpegImages(input, "medium", budget)).not.toBeNull();
  expect(budget.remainingPixels).toBe(0);
  expect(await recompressJpegImages(input, "high", budget)).toBeNull();
  expect(decode).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
  expect(canvases).toEqual([
    { width: 0, height: 0 },
    { width: 0, height: 0 },
  ]);
});

it("bounds a full document's qpdf image passes by the total pixel budget", async () => {
  const input = await imagePdf(14); // 67.76 million pixels, over the shared limit.
  expect(await qpdfImagePixels(input)).toBeNull();
  const { decode, close } = fakeDecoder();
  const budget = createImageBudget();
  await recompressJpegImages(input, "medium", budget);
  await recompressJpegImages(input, "high", budget);
  expect(decode).toHaveBeenCalledTimes(
    Math.floor(COMPRESSION_LIMITS.totalImagePixels / (2200 * 2200))
  );
  expect(close).toHaveBeenCalledTimes(decode.mock.calls.length);
});

it("releases decoded bitmaps and canvases even when encoding fails", async () => {
  const { decode, close, canvases } = fakeDecoder(true);
  expect(await recompressJpegImages(await imagePdf(), "medium")).toBeNull();
  expect(decode).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(canvases).toEqual([{ width: 0, height: 0 }]);
});
