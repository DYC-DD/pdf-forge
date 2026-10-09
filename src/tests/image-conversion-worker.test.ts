import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  ImageWorkerRequest,
  ImageWorkerResponse,
} from "../features/convert/lib/imageConversion.worker";
import { runImageConversion } from "../features/convert/lib/runImageConversion";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<ImageWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request: ImageWorkerRequest | null = null;
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: ImageWorkerRequest) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: ImageWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<ImageWorkerResponse>);
  }
}
const inputs = [{ file: new File(["image"], "photo.jpg"), rotation: 90 }];
const options = { format: "pdf" as const, outputName: "album" };
beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWorker.instances = [];
});

it("passes files/rotations to the Worker, reports progress and terminates after a result", async () => {
  const progress: number[] = [],
    packing: number[] = [];
  const pending = runImageConversion(inputs, {
    ...options,
    onProgress: (done) => progress.push(done),
    onPackingProgress: (percent) => packing.push(percent),
  });
  const worker = FakeWorker.instances[0];
  expect(worker.request).toEqual({ inputs, options });
  worker.emit({ type: "progress", done: 1 });
  worker.emit({ type: "packing", percent: 50 });
  const result = {
    blob: new Blob(["PDF"], { type: "application/pdf" }),
    filename: "album.pdf",
    fileCount: 1,
  };
  worker.emit({ type: "result", result });
  expect(await pending).toBe(result);
  expect(progress).toEqual([1]);
  expect(packing).toEqual([50]);
  expect(worker.terminated).toBe(true);
});
it("terminates immediately on cancellation and ignores late results", async () => {
  const abort = new AbortController(),
    progress = vi.fn();
  const pending = runImageConversion(inputs, {
    ...options,
    signal: abort.signal,
    onProgress: progress,
  });
  const worker = FakeWorker.instances[0];
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminated).toBe(true);
  worker.emit({ type: "progress", done: 1 });
  expect(progress).not.toHaveBeenCalled();
});
it("does not start a Worker when cancelled before work", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    runImageConversion(inputs, { ...options, signal: abort.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeWorker.instances).toHaveLength(0);
});
it("terminates an unresponsive Worker after two minutes", async () => {
  vi.useFakeTimers();
  const pending = runImageConversion(inputs, options);
  const rejected = expect(pending).rejects.toThrow("2 分鐘");
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(FakeWorker.instances[0].terminated).toBe(true);
});
it.each(["error", "onerror", "onmessageerror"] as const)(
  "cleans up a Worker on %s",
  async (kind) => {
    const pending = runImageConversion(inputs, options),
      worker = FakeWorker.instances[0];
    if (kind === "error")
      worker.emit({ type: "error", message: "broken image" });
    else worker[kind]?.();
    await expect(pending).rejects.toThrow();
    expect(worker.terminated).toBe(true);
  }
);
