import { beforeEach, expect, it, vi } from "vitest";

import { compressPdfWithDetails } from "../features/compress/lib/compressPdfBytes";
import { qpdfImagePixels } from "../features/compress/lib/imageResources";
import { recompressJpegImages } from "../features/compress/lib/recompressImages";
import { COMPRESSION_LIMITS, PDF_LIMITS } from "../shared/pdf/limits";

const mock = vi.hoisted(() => ({ runtime: null as FakeQpdf | null }));
vi.mock("@neslinesli93/qpdf-wasm", () => ({
  default: async () => mock.runtime,
}));
vi.mock("../features/compress/lib/imageResources", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../features/compress/lib/imageResources")
  >()),
  qpdfImagePixels: vi.fn(async () => 100),
}));
vi.mock("../features/compress/lib/recompressImages", () => ({
  recompressJpegImages: vi.fn(async () => Uint8Array.of(1)),
}));

class FakeQpdf {
  files = new Map<string, { size: number; bytes: Uint8Array }>();
  calls: string[][] = [];
  reads: string[] = [];
  peakFiles = 0;
  pageCount = 1;
  invalid = new Set<string>();
  sizes: Record<string, number> = {
    "/low.pdf": 1000,
    "/medium.pdf": 800,
    "/medium-images.pdf": 600,
    "/high.pdf": 400,
    "/high-images.pdf": 200,
  };
  stdout: (byte: number | null) => void = () => {};
  FS = {
    init: (_stdin: undefined, stdout: (byte: number | null) => void) => {
      this.stdout = stdout;
    },
    writeFile: (path: string, bytes: Uint8Array) => {
      this.store(path, bytes.byteLength, bytes);
    },
    readFile: (path: string) => {
      this.reads.push(path);
      return this.files.get(path)!.bytes.slice();
    },
    stat: (path: string) => ({ size: this.files.get(path)!.size }),
    unlink: (path: string) => {
      this.files.delete(path);
    },
  };
  store(
    path: string,
    size: number,
    bytes: Uint8Array = new TextEncoder().encode(path)
  ) {
    this.files.set(path, { size, bytes });
    this.peakFiles = Math.max(this.peakFiles, this.files.size);
  }
  callMain(args: string[]) {
    this.calls.push(args);
    if (args.includes("--show-npages")) {
      for (const byte of new TextEncoder().encode(`${this.pageCount}\n`))
        this.stdout(byte);
      return 0;
    }
    if (args[0] === "--check") return this.invalid.has(args[1]) ? 2 : 0;
    const path = args.at(-1)!;
    this.store(path, this.sizes[path]);
    return 0;
  }
}

beforeEach(() => {
  mock.runtime = new FakeQpdf();
  vi.mocked(qpdfImagePixels).mockResolvedValue(100);
  vi.mocked(recompressJpegImages)
    .mockReset()
    .mockResolvedValue(Uint8Array.of(1));
});

it("keeps only the baseline and best candidate, reads no rejected outputs, and removes all temporary files", async () => {
  const runtime = mock.runtime!;
  const result = await compressPdfWithDetails(Uint8Array.of(1), "high");
  expect(result.appliedMode).toBe("high");
  expect(new TextDecoder().decode(result.bytes)).toBe("/high-images.pdf");
  expect(runtime.peakFiles).toBeLessThanOrEqual(4);
  expect(runtime.reads).toEqual(["/low.pdf", "/high-images.pdf"]);
  expect(runtime.files.size).toBe(0);
});

it("keeps a previously validated result when smaller candidates fail validation", async () => {
  const runtime = mock.runtime!;
  runtime.invalid = new Set([
    "/medium-images.pdf",
    "/high.pdf",
    "/high-images.pdf",
  ]);
  const result = await compressPdfWithDetails(Uint8Array.of(1), "high");
  expect(result.appliedMode).toBe("medium");
  expect(new TextDecoder().decode(result.bytes)).toBe("/medium.pdf");
  expect(runtime.reads).toEqual(["/low.pdf", "/medium.pdf"]);
  expect(runtime.files.size).toBe(0);
});

it("rejects an oversized baseline before making a JavaScript copy and cleans up on failure", async () => {
  const runtime = mock.runtime!;
  runtime.sizes["/low.pdf"] = COMPRESSION_LIMITS.workingFileBytes + 1;
  await expect(
    compressPdfWithDetails(Uint8Array.of(1), "high")
  ).rejects.toThrow("資源限制");
  expect(runtime.reads).toEqual([]);
  expect(runtime.files.size).toBe(0);
});

it("rejects excessive pages without starting any compression passes", async () => {
  const runtime = mock.runtime!;
  runtime.pageCount = PDF_LIMITS.pagesPerFile + 1;
  await expect(
    compressPdfWithDetails(Uint8Array.of(1), "high")
  ).rejects.toThrow("600 頁");
  expect(runtime.calls).toHaveLength(1);
  expect(runtime.files.size).toBe(0);
});

it("skips qpdf image passes when image metadata is unsafe and falls back if re-encoding fails", async () => {
  vi.mocked(qpdfImagePixels).mockResolvedValue(null);
  vi.mocked(recompressJpegImages).mockRejectedValue(new Error("decode failed"));
  const result = await compressPdfWithDetails(Uint8Array.of(1), "high");
  expect(result.appliedMode).toBe("low");
  expect(
    mock.runtime!.calls.some((args) => args.includes("--optimize-images"))
  ).toBe(false);
  expect(mock.runtime!.files.size).toBe(0);
});

it("shares the image budget with qpdf and skips later passes when it is exhausted", async () => {
  vi.mocked(qpdfImagePixels).mockResolvedValue(
    COMPRESSION_LIMITS.totalImagePixels
  );
  vi.mocked(recompressJpegImages).mockResolvedValue(null);
  await compressPdfWithDetails(Uint8Array.of(1), "high");
  const imagePasses = mock.runtime!.calls.filter((args) =>
    args.includes("--optimize-images")
  );
  expect(imagePasses).toHaveLength(1);
  const budgets = vi
    .mocked(recompressJpegImages)
    .mock.calls.map((args) => args[2]);
  expect(budgets[0]).toBe(budgets[1]);
  expect(budgets[0]!.remainingPixels).toBe(0);
});
