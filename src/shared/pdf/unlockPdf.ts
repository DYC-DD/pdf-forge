import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";

type QpdfRuntime = {
  callMain: (args: string[]) => number;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
  };
};

const unlockedFiles = new WeakMap<File, Promise<Uint8Array>>();

export function isEncryptedPdfError(error: unknown): boolean {
  return error instanceof Error && /encrypted/i.test(error.message);
}

async function unlock(file: File, wasmUrl: string): Promise<Uint8Array> {
  const { default: createQpdf } = await import("@neslinesli93/qpdf-wasm");
  const qpdf = (await createQpdf({
    locateFile: () => wasmUrl,
  })) as unknown as QpdfRuntime;
  qpdf.FS.writeFile("/input.pdf", new Uint8Array(await file.arrayBuffer()));

  try {
    // This is the same empty-user-password attempt used by pdf_splitter.py.
    const status = qpdf.callMain([
      "--decrypt",
      "--password=",
      "/input.pdf",
      "/output.pdf",
    ]);
    if (status !== 0 && status !== 3) throw new Error("無法以空密碼解鎖");
    const bytes = qpdf.FS.readFile("/output.pdf");
    if (bytes.length === 0) throw new Error("解鎖後的檔案為空");
    return new Uint8Array(bytes);
  } catch {
    throw new Error("這份 PDF 無法以空密碼開啟，可能需要輸入開啟密碼。");
  }
}

export function unlockPdfWithEmptyPassword(
  file: File,
  wasmUrl = qpdfWasmUrl
): Promise<Uint8Array> {
  const cached = unlockedFiles.get(file);
  if (cached) return cached;
  const result = unlock(file, wasmUrl);
  unlockedFiles.set(file, result);
  void result.catch(() => unlockedFiles.delete(file));
  return result;
}
