import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";

import type { CompressionMode } from "../types";
import { recompressJpegImages } from "./recompressImages";

type QpdfRuntime = {
  callMain: (args: string[]) => number;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
  };
};

type CompressionOutcome = {
  bytes: Uint8Array;
  appliedMode: CompressionMode;
};

export async function compressPdfBytes(
  input: Uint8Array,
  mode: CompressionMode,
  wasmUrl = qpdfWasmUrl
): Promise<Uint8Array> {
  return (await compressPdfWithDetails(input, mode, wasmUrl)).bytes;
}

export async function compressPdfWithDetails(
  input: Uint8Array,
  mode: CompressionMode,
  wasmUrl = qpdfWasmUrl
): Promise<CompressionOutcome> {
  if (input.length === 0) throw new Error("PDF 檔案是空的。");
  if (mode !== "low" && mode !== "medium" && mode !== "high") {
    throw new Error("不支援的壓縮模式。");
  }

  const { default: createQpdf } = await import("@neslinesli93/qpdf-wasm");
  const qpdf = (await createQpdf({
    locateFile: () => wasmUrl,
  })) as unknown as QpdfRuntime;
  qpdf.FS.writeFile("/input.pdf", input);

  const baseArgs = [
    "--password=",
    "--decrypt",
    "--object-streams=generate",
    "--recompress-flate",
    "--compression-level=9",
  ];
  function makeCandidate(
    sourcePath: string,
    outputPath: string,
    options: string[] = [],
    appliedMode: CompressionMode = "low"
  ) {
    try {
      const status = qpdf.callMain([
        ...baseArgs,
        ...options,
        sourcePath,
        outputPath,
      ]);
      if (status !== 0 && status !== 3) return null;
      const bytes = new Uint8Array(qpdf.FS.readFile(outputPath));
      return bytes.length > 0 ? { path: outputPath, bytes, appliedMode } : null;
    } catch {
      return null;
    }
  }

  const low = makeCandidate("/input.pdf", "/low.pdf");
  if (!low) {
    throw new Error("無法壓縮這份 PDF，請確認檔案完整且不需要開啟密碼。");
  }
  const lowBytes = low.bytes;
  const candidates = [low];

  async function addJpegCandidate(level: "medium" | "high") {
    try {
      const reencoded = await recompressJpegImages(lowBytes, level);
      if (!reencoded) return;
      const sourcePath = `/${level}-images-input.pdf`;
      qpdf.FS.writeFile(sourcePath, reencoded);
      const optimized = makeCandidate(
        sourcePath,
        `/${level}-images.pdf`,
        [],
        level
      );
      if (optimized) candidates.push(optimized);
    } catch {
      // Keep the structural candidates if an image cannot be processed.
    }
  }

  if (mode === "medium" || mode === "high") {
    const medium = makeCandidate(
      "/input.pdf",
      "/medium.pdf",
      ["--optimize-images", "--jpeg-quality=85"],
      "medium"
    );
    if (medium) candidates.push(medium);
    await addJpegCandidate("medium");
  }

  if (mode === "high") {
    const high = makeCandidate(
      "/input.pdf",
      "/high.pdf",
      ["--optimize-images", "--jpeg-quality=65"],
      "high"
    );
    if (high) candidates.push(high);
    await addJpegCandidate("high");
  }

  candidates.sort((first, second) => first.bytes.length - second.bytes.length);
  for (const candidate of candidates) {
    try {
      const checkStatus = qpdf.callMain(["--check", candidate.path]);
      if (checkStatus === 0 || checkStatus === 3) {
        return { bytes: candidate.bytes, appliedMode: candidate.appliedMode };
      }
    } catch {
      // Try the next candidate if qpdf rejects this output.
    }
  }
  throw new Error("壓縮後的 PDF 無法驗證，已保留原始檔案。");
}
