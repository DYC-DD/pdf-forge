import { readFileSync } from "node:fs";

import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { afterEach, expect, it, vi } from "vitest";

import { compressPdfBytes } from "../features/compress/lib/compressPdfBytes";
import { recompressJpegImages } from "../features/compress/lib/recompressImages";

const wasmPath = new URL(
  "../../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm",
  import.meta.url
).pathname;

afterEach(() => vi.unstubAllGlobals());

async function imageInfo(bytes) {
  const document = await PDFDocument.load(bytes);
  const images = document.context
    .enumerateIndirectObjects()
    .filter(([, object]) =>
      object instanceof PDFRawStream
        ? object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image"
        : false
    );
  return images.map(([, image]) => ({
    width: image.dict.get(PDFName.of("Width")).asNumber(),
    height: image.dict.get(PDFName.of("Height")).asNumber(),
  }));
}

it("medium and high compression reduce an image while retaining page content", async () => {
  const png = readFileSync(
    new URL("../../public/favicon.png", import.meta.url)
  );
  const source = await PDFDocument.create();
  const page = source.addPage([400, 400]);
  page.drawImage(await source.embedPng(png), {
    x: 40,
    y: 40,
    width: 320,
    height: 320,
  });
  page.drawText("Searchable text", { x: 40, y: 370, size: 12 });
  const input = new Uint8Array(await source.save());
  const low = await compressPdfBytes(input, "low", wasmPath);
  const medium = await compressPdfBytes(input, "medium", wasmPath);
  const high = await compressPdfBytes(input, "high", wasmPath);
  const compressed = await PDFDocument.load(high);

  expect(medium.length).toBeLessThan(low.length);
  expect(high.length).toBeLessThan(medium.length);
  expect(compressed.getPageCount()).toBe(1);
}, 30_000);

it("re-encodes existing JPEGs at medium quality and also resizes them at high compression", async () => {
  const sourceJpeg = readFileSync(
    new URL("./fixtures/source.jpg", import.meta.url)
  );
  const mediumJpeg = readFileSync(
    new URL("./fixtures/medium.jpg", import.meta.url)
  );
  const highJpeg = readFileSync(
    new URL("./fixtures/high.jpg", import.meta.url)
  );
  const source = await PDFDocument.create();
  const page = source.addPage([400, 400]);
  page.drawImage(await source.embedJpg(sourceJpeg), {
    x: 40,
    y: 40,
    width: 320,
    height: 320,
  });
  page.drawText("Searchable text", { x: 40, y: 370, size: 12 });
  const input = new Uint8Array(await source.save());

  vi.stubGlobal("createImageBitmap", async () => ({
    width: 2200,
    height: 2200,
    close() {},
  }));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return { drawImage() {} };
      }

      async convertToBlob() {
        return new Blob([this.width === 1800 ? highJpeg : mediumJpeg], {
          type: "image/jpeg",
        });
      }
    }
  );

  const low = await compressPdfBytes(input, "low", wasmPath);
  const medium = await compressPdfBytes(input, "medium", wasmPath);
  const high = await compressPdfBytes(input, "high", wasmPath);
  const resized = await recompressJpegImages(low, "high");

  expect(low.length).toBeGreaterThan(medium.length);
  expect(medium.length).toBeGreaterThan(high.length);
  expect(await imageInfo(low)).toEqual([{ width: 2200, height: 2200 }]);
  expect(await imageInfo(medium)).toEqual([{ width: 2200, height: 2200 }]);
  expect(await imageInfo(resized)).toEqual([{ width: 1800, height: 1800 }]);
  expect((await PDFDocument.load(high)).getPageCount()).toBe(1);
}, 30_000);
