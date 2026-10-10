export type Box = { x: number; y: number; width: number; height: number };
export type TextSpan = Box & {
  id: string;
  text: string;
  baseline: number;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  source: "pdf" | "ocr";
  confidence?: number;
  blockId?: string;
  paragraphId?: string;
  lineId?: string;
  color?: string;
  fontScale?: number;
  underline?: boolean;
  decorative?: boolean;
  hidden?: boolean;
  paintOrder?: number;
  rasterized?: boolean;
  advances?: number[];
  ids?: string[];
  fraction?: { numerator: string; denominator: string };
  spaceAfter?: boolean;
};
export type Rule = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  thickness?: number;
};
export type Fill = Box & {
  color: string;
  paintOrder?: number;
  opaque?: boolean;
};
export type Issue = {
  page: number;
  code: string;
  message: string;
  severity: "info" | "review" | "error";
};
export type Figure = Box & {
  id: string;
  data: Uint8Array;
  overlay?: boolean;
  behindText?: boolean;
  format?: "png" | "jpg";
  inFooter?: boolean;
};
export type RawPage = {
  number: number;
  width: number;
  height: number;
  spans: TextSpan[];
  rules: Rule[];
  figures: Figure[];
  issues: Issue[];
  source: "pdf" | "ocr";
  fills?: Fill[];
};
export type TextRun = {
  text: string;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  breakBefore?: boolean;
  tabBefore?: number;
  color?: string;
  fontScale?: number;
  underline?: boolean;
  pageNumber?: boolean;
  fraction?: { numerator: string; denominator: string };
  width?: number;
  /** Positive values raise the original-size glyph above the line baseline. */
  baselineShift?: number;
  sourceLineStart?: boolean;
  lineSeparator?: string;
};
export type Paragraph = Box & {
  kind: "paragraph";
  role: "body" | "heading" | "list";
  runs: TextRun[];
  ids: string[];
  align: "left" | "center" | "right" | "justify";
  before: number;
  lineHeight: number;
  indent: number;
  firstIndent: number;
  lastLineWidth: number;
  source?: "pdf" | "ocr";
  lineCount?: number;
  rightIndent?: number;
  floatingImages?: ImageBlock[];
};
export type TableCellModel = {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  paragraphs: Paragraph[];
  fill?: string;
  verticalAlign?: "top" | "center" | "bottom";
  padding?: { left: number; right: number };
};
export type TableModel = Box & {
  kind: "table";
  before: number;
  columns: number[];
  rows: number[];
  cells: TableCellModel[];
  border?: { color: string; thickness: number };
  borderless?: boolean;
  horizontalBorders?: { boundary: number; color: string; thickness: number }[];
};
export type ImageBlock = Figure & { kind: "image"; before: number };
export type ImageRow = Box & {
  kind: "image-row";
  before: number;
  images: ImageBlock[];
};
export type RuleBlock = Box & {
  kind: "rule";
  before: number;
  color: string;
  thickness: number;
};
export type FlowBlock =
  Paragraph | TableModel | ImageBlock | ImageRow | RuleBlock;
export type FlowGroup = {
  columns: FlowBlock[][];
  gap: number;
  widths?: number[];
};
export type PageModel = {
  number: number;
  width: number;
  height: number;
  margins: { top: number; bottom: number; left: number; right: number };
  groups: FlowGroup[];
  source: "pdf" | "ocr";
  characters: number;
  footer?: Paragraph;
  overlays?: ImageBlock[];
  classification?: {
    source: "native" | "scan" | "image";
    text: number;
    tables: number;
    rules: number;
    images: number;
  };
};
export type DocumentModel = {
  pages: PageModel[];
  issues: Issue[];
  stats: {
    pages: number;
    characters: number;
    paragraphs: number;
    tables: number;
    images: number;
    ocrPages: number;
    rules?: number;
  };
};
export type OcrMode = "auto" | "off" | "always";
export type OcrLanguage = "chi_tra+eng" | "eng";
export type ConversionProgress = {
  stage: "read" | "ocr" | "layout" | "export";
  page: number;
  total: number;
  detail?: string;
};
export type AnalyzeOptions = {
  ocr: OcrMode;
  language: OcrLanguage;
  signal?: AbortSignal;
  onProgress?: (progress: ConversionProgress) => void;
};
export type PaperSize = "a4" | "a3" | "a5" | "letter" | "source";
export type MarginPreset = "narrow" | "standard";
export type ExportOptions = {
  preservePageBreaks: boolean;
};
