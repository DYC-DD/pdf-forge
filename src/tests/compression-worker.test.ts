import { afterEach, expect, it, vi } from "vitest";

import { compressPdf } from "../features/compress/lib/compressPdf";
import type {
  CompressionWorkerRequest,
  CompressionWorkerResponse,
} from "../features/compress/types";
import { COMPRESSION_LIMITS, PDF_LIMITS } from "../shared/pdf/limits";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<CompressionWorkerResponse>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request: CompressionWorkerRequest | null = null;
  transfers: Transferable[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: CompressionWorkerRequest, transfers: Transferable[]) {
    this.request = request;
    this.transfers = transfers;
  }
  terminate() {
    this.terminated = true;
  }
  emit(response: CompressionWorkerResponse) {
    this.onmessage?.({
      data: response,
    } as MessageEvent<CompressionWorkerResponse>);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

it("rejects invalid inputs before reading the file or starting a Worker", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  for (const file of [
    new File([], "empty.pdf"),
    new File(["a"], "wrong.txt"),
    new File(["a"], "large.pdf"),
  ]) {
    if (file.name === "large.pdf")
      Object.defineProperty(file, "size", { value: PDF_LIMITS.fileBytes + 1 });
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(compressPdf(file, "high")).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  }
  expect(FakeWorker.instances).toHaveLength(0);
});

it("transfers bytes and clears the deadline after returning a result", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const pending = compressPdf(new File(["input"], "input.pdf"), "medium");
  await vi.waitFor(() =>
    expect(FakeWorker.instances[0].request).not.toBeNull()
  );
  const worker = FakeWorker.instances[0];
  expect(worker.transfers).toEqual([worker.request!.bytes]);
  expect(worker.request!.mode).toBe("medium");
  worker.emit({
    type: "success",
    bytes: new TextEncoder().encode("output").buffer,
    appliedMode: "low",
  });
  const result = await pending;
  expect(await result.blob.text()).toBe("output");
  expect(result.appliedMode).toBe("low");
  expect(worker.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("terminates a stalled Worker at the deadline and ignores late results", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const pending = compressPdf(new File(["input"], "input.pdf"), "high");
  const rejected = expect(pending).rejects.toThrow("超過 2 分鐘");
  await vi.advanceTimersByTimeAsync(COMPRESSION_LIMITS.timeoutMs);
  await rejected;
  const worker = FakeWorker.instances[0];
  expect(worker.terminated).toBe(true);
  worker.emit({
    type: "success",
    bytes: new ArrayBuffer(1),
    appliedMode: "high",
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("can cancel during file reading without sending the eventual bytes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const file = new File(["input"], "input.pdf");
  let finishRead!: (bytes: ArrayBuffer) => void;
  vi.spyOn(file, "arrayBuffer").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      })
  );
  const controller = new AbortController();
  const pending = compressPdf(file, "high", controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  finishRead(new ArrayBuffer(4));
  await Promise.resolve();
  expect(FakeWorker.instances[0].request).toBeNull();
  expect(FakeWorker.instances[0].terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a Worker for an already cancelled operation", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const controller = new AbortController();
  controller.abort();
  await expect(
    compressPdf(new File(["input"], "input.pdf"), "low", controller.signal)
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeWorker.instances).toHaveLength(0);
});

it.each(["onerror", "onmessageerror"] as const)(
  "releases the Worker and timer on %s",
  async (handler) => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const pending = compressPdf(new File(["input"], "input.pdf"), "low");
    const worker = FakeWorker.instances[0];
    worker[handler]?.();
    await expect(pending).rejects.toThrow();
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
);
