export type CompressionMode = "low" | "medium" | "high";

export type CompressionWorkerRequest = {
  bytes: ArrayBuffer;
  mode: CompressionMode;
};

export type CompressionWorkerResponse =
  | { type: "success"; bytes: ArrayBuffer; appliedMode: CompressionMode }
  | { type: "error"; message: string };
