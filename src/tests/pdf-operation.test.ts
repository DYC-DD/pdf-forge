import { afterEach, expect, it, vi } from "vitest";

import {
  runMergePdfs,
  type PdfOperationRequest,
  type PdfOperationResponse,
} from "../shared/pdf/runPdfOperation";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<PdfOperationResponse>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request: PdfOperationRequest | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: PdfOperationRequest) {
    this.request = request;
  }

  terminate() {
    this.terminated = true;
  }

  emit(response: PdfOperationResponse) {
    this.onmessage?.({ data: response } as MessageEvent<PdfOperationResponse>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

it("reports Worker progress and returns the merge result", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const files = [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")];
  const progress: number[] = [];
  const pending = runMergePdfs(files, {
    onProgress: (done) => progress.push(done),
  });
  const worker = FakeWorker.instances[0];
  expect(worker.request).toEqual({ type: "merge", files });
  worker.emit({ type: "progress", done: 1 });
  const blob = new Blob(["result"]);
  worker.emit({ type: "merge-result", blob });
  expect(await pending).toBe(blob);
  expect(progress).toEqual([1]);
  expect(worker.terminated).toBe(true);
});

it("terminates an active Worker when cancelled", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const controller = new AbortController();
  const pending = runMergePdfs([], { signal: controller.signal });
  const worker = FakeWorker.instances[0];
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminated).toBe(true);
});
