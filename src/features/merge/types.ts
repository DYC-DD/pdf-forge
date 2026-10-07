export type MergeItem = {
  id: string;
  file: File;
  loading: boolean;
  pageCount?: number;
  thumbnail?: string;
  thumbnailAspectRatio?: number;
  error?: string;
};
