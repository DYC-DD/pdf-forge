export type PageGroup = {
  id: string;
  name: string;
  pages: number[]; // One-based page numbers in source order.
};

export type SplitOutput = {
  blob: Blob;
  filename: string;
  fileCount: number;
};
