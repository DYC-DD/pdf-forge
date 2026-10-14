import { afterEach, expect, it, vi } from "vitest";

import type {
  DocxWorkerRequest,
  DocxWorkerResponse,
} from "../features/pdf2docx/lib/docx.worker";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import { DOCX_LIMITS } from "../features/pdf2docx/lib/limits";
import {
  runDocxExport,
  runLayoutAnalysis,
} from "../features/pdf2docx/lib/runDocxJob";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<DocxWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request: DocxWorkerRequest | null = null;
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: DocxWorkerRequest) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: DocxWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<DocxWorkerResponse>);
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});
it("receives analysis and export results and releases each worker and deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const model = analyzeLayout([]),
    pending = runLayoutAnalysis([]);
  FakeWorker.instances[0].emit({ kind: "analysis", model });
  expect(await pending).toEqual(model);
  const exportPending = runDocxExport(model, { preservePageBreaks: false });
  const blob = new Blob(["docx"]);
  FakeWorker.instances[1].emit({ kind: "export", blob });
  expect(await exportPending).toBe(blob);
  expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("aborts layout and export work, ignores late output and never starts already-aborted work", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const controller = new AbortController(),
    pending = runLayoutAnalysis([], controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  FakeWorker.instances[0].emit({ kind: "analysis", model: analyzeLayout([]) });
  await expect(
    runDocxExport(
      analyzeLayout([]),
      { preservePageBreaks: false },
      controller.signal
    )
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeWorker.instances).toHaveLength(1);
  expect(FakeWorker.instances[0].terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("terminates stalled background jobs", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const result = runLayoutAnalysis([]),
    rejected = expect(result).rejects.toThrow("超過 2 分鐘");
  await vi.advanceTimersByTimeAsync(DOCX_LIMITS.workerTimeoutMs);
  await rejected;
  expect(FakeWorker.instances[0].terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["runtime", "message", "analysis"])(
  "releases workers on %s errors",
  async (failure) => {
    vi.stubGlobal("Worker", FakeWorker);
    const result = runLayoutAnalysis([]),
      worker = FakeWorker.instances[0];
    if (failure === "runtime") worker.onerror?.();
    else if (failure === "message") worker.onmessageerror?.();
    else worker.emit({ kind: "error", message: "Analysis failed" });
    await expect(result).rejects.toThrow();
    expect(worker.terminated).toBe(true);
  }
);
