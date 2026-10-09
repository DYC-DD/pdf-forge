import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  ImageCompressionWorkerRequest,
  ImageCompressionWorkerResponse,
} from "../features/compress/lib/compressImage.worker";
import { runImageCompression } from "../features/compress/lib/runImageCompression";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage:
    ((event: MessageEvent<ImageCompressionWorkerResponse>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request: ImageCompressionWorkerRequest | null = null;
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: ImageCompressionWorkerRequest) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: ImageCompressionWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<ImageCompressionWorkerResponse>);
  }
}
const file = new File(["image"], "photo.jpg", { type: "image/jpeg" });
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

it("sends a single image and terminates after receiving its compression result", async () => {
  vi.useFakeTimers();
  const pending = runImageCompression(file, "medium");
  const worker = FakeWorker.instances[0];
  expect(worker.request).toEqual({ file, mode: "medium" });
  const result = {
    blob: new Blob(["smaller"], { type: "image/jpeg" }),
    appliedMode: "medium" as const,
  };
  worker.emit({ type: "result", result });
  expect(await pending).toBe(result);
  expect(worker.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels immediately and ignores a late result", async () => {
  const abort = new AbortController();
  const pending = runImageCompression(file, "high", abort.signal);
  const worker = FakeWorker.instances[0];
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminated).toBe(true);
  worker.emit({ type: "result", result: { blob: file, appliedMode: "low" } });
});
it("does not start when already cancelled", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    runImageCompression(file, "low", abort.signal)
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeWorker.instances).toHaveLength(0);
});
it("terminates an unresponsive worker after two minutes", async () => {
  vi.useFakeTimers();
  const pending = runImageCompression(file, "medium");
  const rejected = expect(pending).rejects.toThrow("2 分鐘");
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(FakeWorker.instances[0].terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["error", "onerror", "onmessageerror"] as const)(
  "cleans up after %s",
  async (kind) => {
    vi.useFakeTimers();
    const pending = runImageCompression(file, "medium"),
      worker = FakeWorker.instances[0];
    if (kind === "error")
      worker.emit({ type: "error", message: "broken image" });
    else worker[kind]?.();
    await expect(pending).rejects.toThrow();
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
);
