import {
  AlignmentType,
  BorderStyle,
  BuilderElement,
  Column,
  ColumnBreak,
  Document,
  Footer,
  HeadingLevel,
  HeightRule,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LevelFormat,
  LineRuleType,
  MathFraction,
  MathRun,
  Packer,
  PageNumber,
  PageOrientation,
  ParagraphProperties,
  SectionType,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextWrappingType,
  VerticalAlignTable,
  VerticalPositionRelativeFrom,
  WidthType,
  Math as WordMath,
  Paragraph as WordParagraph,
  TextRun as WordRun,
  type ILevelsOptions,
  type IParagraphOptions,
  type IRunOptions,
  type ISectionOptions,
} from "docx";

import type {
  DocumentModel,
  ExportOptions,
  FlowBlock,
  ImageBlock,
  ImageRow,
  PageModel,
  Paragraph,
  TableModel,
  TextRun,
} from "../types";
import {
  createFontResolver,
  fontName,
  measuredScale,
  type WordFonts,
} from "./fontMetrics";
import { bottom, right } from "./geometry";
import { applyPageSetup, detectPageSetups } from "./pageSetup";
import { joinSeparator, paragraphText } from "./paragraphs";

const twips = (points: number) => Math.round(points * 20);
const positive = (points: number) => Math.max(0, twips(points));
const alignment = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};
const border = { style: BorderStyle.SINGLE, size: 4, color: "777777" };
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = {
  top: noBorder,
  bottom: noBorder,
  left: noBorder,
  right: noBorder,
  insideHorizontal: noBorder,
  insideVertical: noBorder,
};
const emu = (points: number) => Math.round(points * 12700);

class MeasuredRun extends WordRun {
  constructor(options: IRunOptions, width?: number, id = 0) {
    super(options);
    if (width !== undefined && width > 0)
      this.properties.push(
        new BuilderElement({
          name: "w:fitText",
          attributes: {
            val: { key: "w:val", value: positive(width) },
            id: { key: "w:id", value: id },
          },
        })
      );
  }
}
class SourceParagraph extends WordParagraph {
  constructor(options: IParagraphOptions) {
    super(options);
    this.root
      .find((item) => item instanceof ParagraphProperties)
      ?.push(
        new BuilderElement({
          name: "w:autoSpaceDE",
          attributes: { val: { key: "w:val", value: false } },
        })
      );
  }
}
function textRun(
  run: TextRun,
  fonts: WordFonts,
  scale?: number,
  width?: number,
  id = 0
): WordRun | WordMath {
  if (run.fraction)
    return new WordMath({
      children: [
        new MathFraction({
          numerator: [
            new MathRun({ text: run.fraction.numerator, normalText: true }),
          ],
          denominator: [
            new MathRun({ text: run.fraction.denominator, normalText: true }),
          ],
        }),
      ],
    });
  return new MeasuredRun(
    {
      text:
        run.tabBefore === undefined && !run.pageNumber ? run.text : undefined,
      children: run.pageNumber
        ? [
            ...(run.tabBefore === undefined ? [] : [new Tab()]),
            PageNumber.CURRENT,
          ]
        : run.tabBefore === undefined
          ? undefined
          : [new Tab(), run.text],
      break: run.breakBefore ? 1 : undefined,
      bold: run.bold,
      italics: run.italic,
      font: fonts,
      size: Math.round(Math.max(4, Math.min(144, run.size)) * 2),
      language: { value: "en-US", eastAsia: "zh-TW" },
      snapToGrid: false,
      color: run.color,
      scale:
        (scale ?? run.fontScale) !== undefined &&
        (scale ?? run.fontScale) !== 100
          ? Math.max(10, Math.min(300, (scale ?? run.fontScale)!))
          : undefined,
      underline: run.underline ? {} : undefined,
    },
    width,
    id
  );
}

type NumberingConfig = { reference: string; levels: ILevelsOptions[] };
class Writer {
  numbering: NumberingConfig[] = [];
  private listReference = "";
  private listNumber = -1;
  private listFormat = "";
  private fitId = 0;
  private fonts = createFontResolver();

  paragraph(
    paragraph: Paragraph,
    inCell = false,
    columnBreak = false,
    left = 0,
    availableWidth = 0,
    pageImages: ImageBlock[] = []
  ): WordParagraph {
    const text = paragraphText(paragraph);
    const marker =
      paragraph.role === "list" && !inCell
        ? /^(?:([•●▪◦‣–－-])\s*|([（(]?)(\d{1,3})([.)、）])(?!\d)\s*)/u.exec(
            text
          )
        : null;
    let runs = paragraph.runs.map((run) => ({ ...run }));
    let numbering: { reference: string; level: number } | undefined;
    if (marker) {
      const bullet = !!marker[1];
      const start = bullet ? 1 : Number(marker[3]);
      const format = bullet ? marker[1] : `${marker[2]}%1${marker[4]}`;
      if (
        !this.listReference ||
        this.listFormat !== format ||
        (!bullet && start !== this.listNumber + 1)
      ) {
        this.listReference = `list-${this.numbering.length}`;
        this.numbering.push({
          reference: this.listReference,
          levels: [
            {
              level: 0,
              format: bullet ? LevelFormat.BULLET : LevelFormat.DECIMAL,
              text: format,
              start,
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: {
                    left: positive(paragraph.indent + 15),
                    hanging: 300,
                  },
                },
              },
            },
          ],
        });
      }
      this.listNumber = start;
      this.listFormat = format;
      numbering = { reference: this.listReference, level: 0 };
      let remaining = marker[0].length;
      runs = runs.map((run) => {
        const count = Math.min(remaining, run.text.length);
        remaining -= count;
        return { ...run, text: run.text.slice(count) };
      });
    } else {
      this.listReference = "";
      this.listNumber = -1;
    }
    return new SourceParagraph({
      children: [
        ...pageImages.map((image, index) =>
          this.image(image, image.width, {
            horizontalPosition: {
              relative: HorizontalPositionRelativeFrom.PAGE,
              offset: emu(image.x),
            },
            verticalPosition: {
              relative: VerticalPositionRelativeFrom.PAGE,
              offset: emu(image.y),
            },
            behindDocument: true,
            allowOverlap: true,
            zIndex: index + 1,
            wrap: { type: TextWrappingType.NONE },
          })
        ),
        ...(columnBreak ? [new ColumnBreak()] : []),
        ...(paragraph.floatingImages ?? []).map((image) =>
          this.image(image, availableWidth, {
            horizontalPosition: {
              relative: HorizontalPositionRelativeFrom.COLUMN,
              offset: emu(image.x - left),
            },
            verticalPosition: {
              relative: VerticalPositionRelativeFrom.PARAGRAPH,
              // Paragraph anchoring includes its space-before area.
              offset: emu(
                Math.min(paragraph.before, 144) + image.y - paragraph.y
              ),
            },
            allowOverlap: false,
            layoutInCell: true,
            behindDocument: false,
            margins: { left: emu(6), right: emu(6), top: 0, bottom: 0 },
            wrap: {
              type: TextWrappingType.SQUARE,
              margins: { distL: emu(6), distR: emu(6), distT: 0, distB: 0 },
            },
          })
        ),
        ...runs.map((run, index) => {
          const fonts = this.fonts.resolve(run.font);
          let width: number | undefined;
          if (
            ((inCell && paragraph.source === "pdf") ||
              paragraph.source === "ocr") &&
            run.width !== undefined
          ) {
            let start = index,
              end = index + 1;
            while (start > 0 && !runs[start].breakBefore) start--;
            while (end < runs.length && !runs[end].breakBefore) end++;
            const lineWidth = runs
              .slice(start, end)
              .reduce((sum, item) => sum + (item.width ?? 0), 0);
            const indent =
              paragraph.indent + (start === 0 ? paragraph.firstIndent : 0);
            const available = Math.max(
              1,
              availableWidth - indent - (paragraph.rightIndent ?? 0) - 1.5
            );
            width = run.width * Math.min(1, available / Math.max(1, lineWidth));
          }
          const scale =
            width === undefined
              ? undefined
              : measuredScale(run, width, this.fonts.measure(run, fonts));
          return textRun(
            run,
            fonts,
            scale,
            scale === undefined && paragraph.source === "pdf"
              ? width
              : undefined,
            ++this.fitId
          );
        }),
      ],
      heading:
        paragraph.role === "heading" ? HeadingLevel.HEADING_2 : undefined,
      run: paragraph.runs.some((run) => run.fraction)
        ? {
            size: Math.round(paragraph.runs[0].size * 2),
            font: fontName(paragraph.runs[0].font),
          }
        : undefined,
      alignment: alignment[paragraph.align],
      numbering,
      tabStops: paragraph.runs
        .filter((run) => run.tabBefore !== undefined)
        .map((run) => ({
          type: TabStopType.LEFT,
          position: twips(run.tabBefore! - left),
        })),
      indent: marker
        ? undefined
        : {
            left: twips(paragraph.indent),
            right: twips(paragraph.rightIndent ?? 0),
            firstLine:
              paragraph.firstIndent >= 0
                ? positive(paragraph.firstIndent)
                : undefined,
            hanging:
              paragraph.firstIndent < 0
                ? positive(-paragraph.firstIndent)
                : undefined,
          },
      spacing: {
        before: inCell ? 0 : positive(paragraph.before),
        after: positive(
          Math.max(
            0,
            ...(paragraph.floatingImages ?? []).map(
              (image) => bottom(image) - paragraph.y - paragraph.lineHeight
            )
          )
        ),
        line: positive(
          Math.max(
            paragraph.lineHeight,
            ...paragraph.runs.map((run) => run.size)
          )
        ),
        lineRule: LineRuleType.EXACT,
      },
      keepNext: !inCell && paragraph.role === "heading",
      widowControl: paragraph.source !== "ocr",
      contextualSpacing: false,
      autoSpaceEastAsianText: false,
    });
  }

  image(
    image: ImageBlock,
    availableWidth: number,
    floating?: import("docx").IFloating
  ): ImageRun {
    const factor = Math.min(1, Math.max(1, availableWidth) / image.width);
    return new ImageRun({
      type: image.format ?? "png",
      data: image.data,
      transformation: {
        width: (image.width * factor * 96) / 72,
        height: (image.height * factor * 96) / 72,
      },
      floating,
    });
  }

  imageRow(row: ImageRow, left: number): Table {
    const cells: { width: number; image?: ImageBlock }[] = [];
    let cursor = row.x;
    for (const image of row.images) {
      const gap = image.x - cursor;
      if (gap > 0.5) cells.push({ width: gap });
      cells.push({ width: image.width, image });
      cursor = right(image);
    }
    const widths = cells.map((cell) => twips(cell.width));
    return new Table({
      width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      indent: { size: positive(row.x - left), type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      borders: noBorders,
      rows: [
        new TableRow({
          children: cells.map(
            (cell, index) =>
              new TableCell({
                width: { size: widths[index], type: WidthType.DXA },
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                borders: noBorders,
                children: [
                  new WordParagraph({
                    children: cell.image
                      ? [this.image(cell.image, cell.width)]
                      : [],
                    spacing: {
                      before: 0,
                      after: 0,
                      line: 1,
                      lineRule: LineRuleType.AT_LEAST,
                    },
                  }),
                ],
              })
          ),
        }),
      ],
    });
  }

  table(table: TableModel, left: number): Table {
    this.listReference = "";
    const tableBorder = table.border
      ? {
          style: BorderStyle.SINGLE,
          color: table.border.color,
          size: Math.max(2, Math.round(table.border.thickness * 8)),
        }
      : border;
    return new Table({
      width: { size: twips(table.width), type: WidthType.DXA },
      indent: { size: positive(table.x - left), type: WidthType.DXA },
      columnWidths: table.columns.map(twips),
      layout: TableLayoutType.FIXED,
      borders: {
        top: tableBorder,
        bottom: tableBorder,
        left: tableBorder,
        right: tableBorder,
        insideHorizontal: tableBorder,
        insideVertical: tableBorder,
      },
      rows: table.rows.map(
        (height, row) =>
          new TableRow({
            // PDF row distances include the border center lines. Word adds the
            // border to its minimum interior height; avoid accumulating it twice.
            height: {
              value: positive(height - (table.border?.thickness ?? 0.5)),
              rule: HeightRule.ATLEAST,
            },
            children: table.cells
              .filter((cell) => cell.row === row)
              .sort((a, b) => a.column - b.column)
              .map(
                (cell) =>
                  new TableCell({
                    width: {
                      size: twips(
                        table.columns
                          .slice(cell.column, cell.column + cell.columnSpan)
                          .reduce((a, b) => a + b, 0)
                      ),
                      type: WidthType.DXA,
                    },
                    columnSpan: cell.columnSpan,
                    rowSpan: cell.rowSpan,
                    shading: cell.fill ? { fill: cell.fill } : undefined,
                    verticalAlign:
                      cell.verticalAlign === "center"
                        ? VerticalAlignTable.CENTER
                        : VerticalAlignTable.TOP,
                    margins: {
                      top: 0,
                      bottom: 0,
                      left: positive(cell.padding?.left ?? 3),
                      right: positive(cell.padding?.right ?? 3),
                    },
                    children: cell.paragraphs.length
                      ? cell.paragraphs.map((paragraph) =>
                          this.paragraph(
                            paragraph,
                            true,
                            false,
                            table.x +
                              table.columns
                                .slice(0, cell.column)
                                .reduce((sum, width) => sum + width, 0) +
                              (cell.padding?.left ?? 3),
                            table.columns
                              .slice(cell.column, cell.column + cell.columnSpan)
                              .reduce((sum, width) => sum + width, 0) -
                              (cell.padding?.left ?? 3) -
                              (cell.padding?.right ?? 3)
                          )
                        )
                      : [
                          new WordParagraph({
                            children: [],
                            spacing: {
                              before: 0,
                              after: 0,
                              line: 1,
                              lineRule: LineRuleType.EXACT,
                            },
                          }),
                        ],
                  })
              ),
          })
      ),
    });
  }

  block(
    block: FlowBlock,
    availableWidth: number,
    left: number,
    columnBreak = false
  ): WordParagraph | Table {
    if (block.kind === "paragraph")
      return this.paragraph(block, false, columnBreak, left, availableWidth);
    if (block.kind === "table") return this.table(block, left);
    if (block.kind === "image-row") return this.imageRow(block, left);
    if (block.kind === "rule")
      return new WordParagraph({
        children: [],
        indent: {
          left: positive(block.x - left),
          right: positive(left + availableWidth - right(block)),
        },
        spacing: {
          before: positive(block.before),
          after: 0,
          line: 1,
          lineRule: LineRuleType.EXACT,
        },
        border: {
          bottom: {
            style: BorderStyle.SINGLE,
            size: Math.max(2, Math.round(block.thickness * 8)),
            color: block.color,
            space: 0,
          },
        },
      });
    this.listReference = "";
    const indent = Math.max(0, Math.min(block.x - left, availableWidth - 1));
    return new WordParagraph({
      children: [
        ...(columnBreak ? [new ColumnBreak()] : []),
        this.image(block, availableWidth - indent),
      ],
      indent: { left: positive(indent) },
      spacing: { before: positive(block.before), after: 0 },
    });
  }
}

function samePage(a: PageModel, b: PageModel): boolean {
  return (
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1 &&
    Math.abs(a.margins.left - b.margins.left) < 4 &&
    Math.abs(a.margins.right - b.margins.right) < 4
  );
}

export function prepareExportPages(
  model: DocumentModel,
  options: ExportOptions
): PageModel[] {
  const pages = structuredClone(model.pages);
  if (options.preservePageBreaks) return pages;
  // Join only unambiguous single-column continuations. Keep original source
  // geometry in the analysis model; this adjustment applies to export only.
  for (let index = 1; index < pages.length; index++) {
    const previous = pages[index - 1],
      current = pages[index];
    if (
      !samePage(previous, current) ||
      current.number !== previous.number + 1 ||
      previous.groups.length !== 1 ||
      current.groups.length !== 1 ||
      previous.groups[0].columns.length !== 1 ||
      current.groups[0].columns.length !== 1
    )
      continue;
    const left = previous.groups[0].columns[0],
      right = current.groups[0].columns[0];
    const tail = left[left.length - 1],
      head = right[0];
    const width =
      previous.width - previous.margins.left - previous.margins.right;
    if (
      tail?.kind !== "paragraph" ||
      head?.kind !== "paragraph" ||
      tail.role !== "body" ||
      head.role !== "body" ||
      tail.floatingImages?.length ||
      head.floatingImages?.length ||
      tail.lastLineWidth < width * 0.82 ||
      head.firstIndent > 3 ||
      /[。！？.!?:：;；]$/u.test(paragraphText(tail).trim()) ||
      Math.abs(tail.runs[0].size - head.runs[0].size) > 1
    )
      continue;
    if (head.runs[0])
      head.runs[0].text =
        joinSeparator(paragraphText(tail), head.runs[0].text) +
        head.runs[0].text;
    tail.runs.push(...head.runs);
    tail.ids.push(...head.ids);
    tail.lastLineWidth = head.lastLineWidth;
    right.shift();
  }
  return pages;
}

export async function exportDocx(
  model: DocumentModel,
  options: ExportOptions
): Promise<Blob> {
  if (model.issues.some((issue) => issue.severity === "error"))
    throw new Error("仍有未能完整讀取的頁面，請調整頁碼或辨識模式後重新分析。");
  if (!model.stats.characters && !model.stats.images)
    throw new Error("沒有可輸出的文字，請啟用 OCR 或改用文字型 PDF。");
  const writer = new Writer();
  const sections: ISectionOptions[] = [];
  const setups = detectPageSetups(model.pages);
  const pages = prepareExportPages(model, options).map((page, index) =>
    applyPageSetup(page, setups[index])
  );
  let previousPage: PageModel | undefined;
  for (const page of pages) {
    const footer = page.footer;
    // Numeric OCR footers need no extra leading. Keep their bottom anchor and
    // type size, but do not reserve blank leading above the final body line.
    const footerParagraph =
      footer?.source === "ocr" &&
      footer.runs.length > 0 &&
      footer.runs.every((run) => run.pageNumber)
        ? {
            ...footer,
            lineHeight: Math.max(...footer.runs.map((run) => run.size)),
          }
        : footer;
    const sourceNumber =
      footer?.runs.find((run) => run.pageNumber)?.text ??
      (footer ? paragraphText(footer).trim() : "");
    const footerNumber = /^\d{1,4}$/u.test(sourceNumber.trim())
      ? Number(sourceNumber)
      : undefined;
    const width = page.width - page.margins.left - page.margins.right;
    for (const [groupIndex, group] of page.groups.entries()) {
      const columns = group.columns.length;
      const children: (WordParagraph | Table)[] = [];
      if (groupIndex === 0 && page.overlays?.length)
        children.push(
          new WordParagraph({
            children: page.overlays
              .filter((image) => !image.inFooter)
              .map((image, index) =>
                writer.image(image, page.width, {
                  horizontalPosition: {
                    relative: HorizontalPositionRelativeFrom.PAGE,
                    offset: emu(image.x),
                  },
                  verticalPosition: {
                    relative: VerticalPositionRelativeFrom.PAGE,
                    offset: emu(image.y),
                  },
                  allowOverlap: true,
                  zIndex: index + 1,
                  behindDocument: image.behindText ?? false,
                  wrap: { type: TextWrappingType.NONE },
                })
              ),
            spacing: {
              before: 0,
              after: 0,
              line: 1,
              lineRule: LineRuleType.EXACT,
            },
          })
        );
      let columnLeft = page.margins.left;
      group.columns.forEach((blocks, index) => {
        const columnWidth =
          group.widths?.[index] ??
          (width - group.gap * (columns - 1)) / columns;
        if (
          index &&
          (!blocks.length ||
            blocks[0].kind === "table" ||
            blocks[0].kind === "image-row")
        )
          children.push(
            new WordParagraph({
              children: [new ColumnBreak()],
              spacing: {
                before: 0,
                after: 0,
                line: 1,
                lineRule: LineRuleType.EXACT,
              },
            })
          );
        for (const [blockIndex, block] of blocks.entries()) {
          if (
            (block.kind === "table" || block.kind === "image-row") &&
            block.before > 1
          )
            children.push(
              new WordParagraph({
                children: [],
                spacing: {
                  before: positive(block.before),
                  after: 0,
                  line: 1,
                  lineRule: LineRuleType.EXACT,
                },
                keepNext: true,
              })
            );
          children.push(
            writer.block(
              block,
              columnWidth,
              columnLeft,
              index > 0 && blockIndex === 0
            )
          );
        }
        columnLeft += columnWidth + group.gap;
      });
      const last = sections[sections.length - 1];
      const singleContinuation =
        last &&
        previousPage &&
        samePage(previousPage, page) &&
        !options.preservePageBreaks &&
        groupIndex === 0 &&
        columns === 1 &&
        last.properties?.column?.count === 1;
      if (singleContinuation)
        (last.children as (WordParagraph | Table)[]).push(...children);
      else
        sections.push({
          properties: {
            type:
              sections.length === 0 ||
              (groupIndex === 0 &&
                (options.preservePageBreaks ||
                  (previousPage && !samePage(previousPage, page))))
                ? SectionType.NEXT_PAGE
                : SectionType.CONTINUOUS,
            page: {
              size: {
                width: twips(Math.min(page.width, page.height)),
                height: twips(Math.max(page.width, page.height)),
                orientation:
                  page.width > page.height
                    ? PageOrientation.LANDSCAPE
                    : PageOrientation.PORTRAIT,
              },
              margin: {
                top: positive(page.margins.top),
                bottom: positive(page.margins.bottom),
                left: positive(page.margins.left),
                right: positive(page.margins.right),
                header: 0,
                footer: footer
                  ? positive(page.height - footer.y - footer.lineHeight)
                  : 0,
              },
              pageNumbers:
                footerNumber !== undefined
                  ? { start: footerNumber }
                  : undefined,
            },
            column: {
              count: columns,
              equalWidth: columns === 1,
              space: positive(group.gap),
              children:
                columns > 1
                  ? Array.from(
                      { length: columns },
                      (_, index) =>
                        new Column({
                          width: twips(
                            group.widths?.[index] ??
                              (width - group.gap * (columns - 1)) / columns
                          ),
                          space: index < columns - 1 ? positive(group.gap) : 0,
                        })
                    )
                  : undefined,
            },
          },
          children: children.length
            ? children
            : [new WordParagraph({ children: [] })],
          footers: footer
            ? {
                default: new Footer({
                  children: [
                    writer.paragraph(
                      footerParagraph!,
                      false,
                      false,
                      page.margins.left,
                      width,
                      page.overlays?.filter((image) => image.inFooter)
                    ),
                  ],
                }),
              }
            : {
                default: new Footer({
                  children: [
                    new WordParagraph({
                      children: [],
                      spacing: { line: 1, lineRule: LineRuleType.EXACT },
                    }),
                  ],
                }),
              },
        });
    }
    previousPage = page;
  }
  const document = new Document({
    creator: "PDF Forge",
    title: "",
    description: "",
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: "Arial", eastAsia: "微軟正黑體" },
            size: 22,
            color: "000000",
          },
          paragraph: { spacing: { after: 0 } },
        },
      },
      paragraphStyles: [
        {
          id: "Heading2",
          name: "heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: "000000" },
          paragraph: { spacing: { before: 0, after: 0 } },
        },
      ],
    },
    numbering: { config: writer.numbering },
    sections,
  });
  return Packer.toBlob(document);
}
