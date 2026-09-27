export type PageGroup = {
  id: string;
  name: string;
  filename?: string; // Optional custom output filename; defaults to the source name and group name.
  pages: number[]; // One-based page numbers in source order.
};

export type SplitOutput = {
  blob: Blob;
  filename: string;
  fileCount: number;
};
