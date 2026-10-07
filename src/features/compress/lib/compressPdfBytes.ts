import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";

import {
  COMPRESSION_LIMITS,
  pdfBytesError,
  pdfPageCountError,
} from "../../../shared/pdf/limits";
import type { CompressionMode } from "../types";
import {
  createImageBudget,
  qpdfImagePixels,
  reserveImagePixels,
} from "./imageResources";
import { recompressJpegImages } from "./recompressImages";

type QpdfRuntime = {
  callMain: (args: string[]) => number;
  FS: {
    init: (
      stdin: undefined,
      stdout: (byte: number | null) => void,
      stderr: (byte: number | null) => void
    ) => void;
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    stat: (path: string) => { size: number };
    unlink: (path: string) => void;
  };
};

type CompressionOutcome = {
  bytes: Uint8Array;
  appliedMode: CompressionMode;
};

type Candidate = { path: string; size: number; appliedMode: CompressionMode };

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
  const inputError = pdfBytesError(input.byteLength);
  if (inputError) throw new Error(inputError);
  if (mode !== "low" && mode !== "medium" && mode !== "high") {
    throw new Error("不支援的壓縮模式。");
  }

  const { default: createQpdf } = await import("@neslinesli93/qpdf-wasm");
  const runtimeOptions = {
    locateFile: () => wasmUrl,
    // This build binds console.log directly instead of accepting `print`.
    // Initialize its streams ourselves to capture a bounded page-count reply.
    noFSInit: true,
  };
  const qpdf = (await createQpdf(runtimeOptions)) as unknown as QpdfRuntime;
  let stdout = "";
  qpdf.FS.init(
    undefined,
    (byte) => {
      if (byte !== null && stdout.length < 128)
        stdout += String.fromCharCode(byte);
    },
    () => {}
  );
  const paths = new Set<string>();
  const remove = (path: string) => {
    try {
      qpdf.FS.unlink(path);
    } catch {
      /* Output may not have been created. */
    }
    paths.delete(path);
  };
  const baseArgs = [
    "--password=",
    "--decrypt",
    "--object-streams=generate",
    "--recompress-flate",
    "--compression-level=9",
  ];
  const selection: { best: Candidate | null } = { best: null };

  function makeCandidate(
    sourcePath: string,
    outputPath: string,
    options: string[] = [],
    appliedMode: CompressionMode = "low"
  ) {
    paths.add(outputPath);
    let retained = false;
    try {
      const status = qpdf.callMain([
        ...baseArgs,
        ...options,
        sourcePath,
        outputPath,
      ]);
      if (status !== 0 && status !== 3) return;
      const size = qpdf.FS.stat(outputPath).size;
      if (
        size <= 0 ||
        size > COMPRESSION_LIMITS.workingFileBytes ||
        (selection.best && size >= selection.best.size)
      )
        return;
      const checkStatus = qpdf.callMain(["--check", outputPath]);
      if (checkStatus !== 0 && checkStatus !== 3) return;
      if (selection.best && selection.best.path !== "/low.pdf")
        remove(selection.best.path);
      selection.best = { path: outputPath, size, appliedMode };
      retained = true;
    } catch {
      // Keep the last verified candidate if this pass fails.
    } finally {
      if (!retained) remove(outputPath);
    }
  }

  try {
    paths.add("/input.pdf");
    qpdf.FS.writeFile("/input.pdf", input);
    const pageStatus = qpdf.callMain([
      "--password=",
      "--show-npages",
      "/input.pdf",
    ]);
    if ((pageStatus !== 0 && pageStatus !== 3) || !/^\d+\s*$/.test(stdout)) {
      throw new Error("無法壓縮這份 PDF，請確認檔案完整且不需要開啟密碼。");
    }
    const pageError = pdfPageCountError(Number(stdout.trim()));
    if (pageError) throw new Error(pageError);

    makeCandidate("/input.pdf", "/low.pdf");
    remove("/input.pdf");
    if (!selection.best)
      throw new Error("無法產生符合資源限制且可驗證的 PDF；請拆分檔案後重試。");
    if (mode !== "low") {
      const lowBytes = qpdf.FS.readFile("/low.pdf");
      const budget = createImageBudget();
      const pixels = await qpdfImagePixels(lowBytes).catch(() => null);
      for (const level of mode === "high"
        ? (["medium", "high"] as const)
        : (["medium"] as const)) {
        if (
          pixels !== null &&
          pixels > 0 &&
          reserveImagePixels(budget, pixels)
        ) {
          makeCandidate(
            "/low.pdf",
            `/${level}.pdf`,
            [
              "--optimize-images",
              `--jpeg-quality=${level === "high" ? 65 : 85}`,
            ],
            level
          );
        }
        const sourcePath = "/images-input.pdf";
        try {
          const reencoded = await recompressJpegImages(lowBytes, level, budget);
          if (
            !reencoded ||
            reencoded.byteLength > COMPRESSION_LIMITS.workingFileBytes
          )
            continue;
          paths.add(sourcePath);
          qpdf.FS.writeFile(sourcePath, reencoded);
          makeCandidate(sourcePath, `/${level}-images.pdf`, [], level);
        } catch {
          // Unsupported or over-budget images keep their original streams.
        } finally {
          remove(sourcePath);
        }
      }
    }
    const result = selection.best;
    return {
      bytes: qpdf.FS.readFile(result.path),
      appliedMode: result.appliedMode,
    };
  } finally {
    for (const path of paths) remove(path);
  }
}
