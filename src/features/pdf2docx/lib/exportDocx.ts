import {
  AlignmentType,
  BorderStyle,
  BuilderElement,
  Column,
  ColumnBreak,
  Document,
  Footer,
  FrameAnchorType,
  FrameWrap,
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
  TextDirection,
  TextWrappingType,
  VerticalAlignTable,
  VerticalPositionRelativeFrom,
  WidthType,
  Math as WordMath,
  Paragraph as WordParagraph,
  TextRun as WordRun,
  type IFrameOptions,
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
import { anchorFormControls } from "./formControls";
import { bottom, right } from "./geometry";
import { applyPageSetup, detectPageSetups } from "./pageSetup";
import { joinSeparator, paragraphText } from "./paragraphs";
import { anchorTextBackgrounds } from "./textBackgrounds";

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
      position: run.baselineShift ? `${run.baselineShift}pt` : undefined,
    },
    // Word's fitText can split/reverse shaped glyph clusters. Keep native
    // shaping for these scripts; source size and bounded font scaling remain.
    /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]/u.test(run.text)
      ? undefined
      : width,
    id
  );
}

type NumberingConfig = { reference: string; levels: ILevelsOptions[] };
class Writer {
  constructor(private preserveSourceLines = false) {}
  numbering: NumberingConfig[] = [];
  private listReference = "";
  private listNumber = -1;
  private listFormat = "";
  private listFontKey = "";
  private fitId = 0;
  private fonts = createFontResolver();

  paragraph(
    paragraph: Paragraph,
    inCell = false,
    columnBreak = false,
    left = 0,
    availableWidth = 0,
    pageImages: ImageBlock[] = [],
    frame?: IFrameOptions
  ): WordParagraph {
    const sourceStarts = paragraph.runs.filter(
      (run, index) => index === 0 || run.sourceLineStart
    );
    if (
      this.preserveSourceLines &&
      paragraph.source === "pdf" &&
      paragraph.role !== "list" &&
      sourceStarts.length > 2 &&
      sourceStarts.every((run) => run.sourceLineX !== undefined) &&
      paragraph.runs.every(
        (run) =>
          run.width !== undefined &&
          !run.fraction &&
          !run.baselineShift &&
          !/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]/u.test(
            run.text
          )
      )
    ) {
      const base = Math.min(
        ...sourceStarts.slice(1).map((run) => run.sourceLineX!)
      );
      paragraph = {
        ...paragraph,
        align: "left",
        indent: base - left,
        firstIndent: sourceStarts[0].sourceLineX! - base,
        runs: paragraph.runs.map((run) =>
          run.sourceLineStart && run.sourceLineX! > base + 0.5
            ? { ...run, tabBefore: run.sourceLineX }
            : run
        ),
      };
    }
    const text = paragraphText(paragraph);
    const marker =
      paragraph.role === "list" && !inCell
        ? /^(?:([•●▪◦‣–－-])\s*|([（(]?)(\d{1,3})([.)、）])(?!\d)\s*)/u.exec(
            text
          )
        : null;
    let runs = paragraph.runs.map((run) =>
      this.preserveSourceLines &&
      paragraph.source === "pdf" &&
      (!marker ||
        paragraph.runs.some((item) => item.tabBefore !== undefined)) &&
      run.sourceLineStart &&
      !run.breakBefore
        ? {
            ...run,
            breakBefore: true,
            text: run.text.slice(run.lineSeparator?.length ?? 0),
          }
        : { ...run }
    );
    let numbering: { reference: string; level: number } | undefined;
    let listIndent:
      { left: number; hanging: number; right: number } | undefined;
    if (marker) {
      const bullet = !!marker[1];
      const start = bullet ? 1 : Number(marker[3]);
      const format = bullet ? marker[1] : `${marker[2]}%1${marker[4]}`;
      const measuredMarker =
        this.preserveSourceLines &&
        paragraph.source === "pdf" &&
        paragraph.lineCount === 1
          ? paragraph.listMarkerWidth
          : undefined;
      const labelRun = runs[0];
      // A native marker can have a different color from its body text even
      // when no measured label gap is available. Keep that color in the
      // numbering definition and in its reuse key.
      const markerColor =
        paragraph.source === "pdf" ? labelRun.color : undefined;
      const fontKey =
        measuredMarker === undefined
          ? markerColor === undefined
            ? ""
            : JSON.stringify([markerColor])
          : JSON.stringify([
              labelRun.font,
              labelRun.size,
              labelRun.bold,
              labelRun.italic,
              labelRun.color,
            ]);
      const listLeft =
        measuredMarker === undefined
          ? paragraph.firstIndent < 0
            ? paragraph.indent
            : paragraph.indent + 15
          : paragraph.indent + paragraph.firstIndent + measuredMarker;
      const hanging = listLeft - paragraph.indent - paragraph.firstIndent;
      listIndent = {
        left: twips(listLeft),
        hanging: positive(hanging),
        right: twips(paragraph.rightIndent ?? 0),
      };
      if (
        !this.listReference ||
        this.listFormat !== format ||
        this.listFontKey !== fontKey ||
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
                run:
                  measuredMarker === undefined
                    ? markerColor === undefined
                      ? undefined
                      : { color: markerColor }
                    : {
                        font: this.fonts.resolve(labelRun.font),
                        size: Math.round(labelRun.size * 2),
                        bold: labelRun.bold,
                        italics: labelRun.italic,
                        color: labelRun.color,
                      },
                paragraph: {
                  indent: {
                    left: positive(listLeft),
                    hanging: positive(hanging),
                  },
                },
              },
            },
          ],
        });
      }
      this.listNumber = start;
      this.listFormat = format;
      this.listFontKey = fontKey;
      numbering = { reference: this.listReference, level: 0 };
      let remaining = marker[0].length;
      runs = runs.map((run, index) => {
        const count = Math.min(remaining, run.text.length);
        remaining -= count;
        return {
          ...run,
          text: run.text.slice(count),
          width:
            run.width === undefined
              ? undefined
              : index === 0 && measuredMarker !== undefined
                ? Math.max(0, run.width - measuredMarker)
                : (run.width * (run.text.length - count)) /
                  Math.max(1, run.text.length),
        };
      });
    } else {
      this.listReference = "";
      this.listNumber = -1;
    }
    const terminalRun = runs.at(-1);
    // Two independently positioned, same-font heading labels may deliberately
    // use different sizes. Preserve those sizes while anchoring the final label.
    const mixedSizeFieldHeading =
      paragraph.role === "heading" &&
      runs.length === 2 &&
      runs[0].tabBefore === undefined &&
      terminalRun?.tabBefore !== undefined &&
      runs.every((run) =>
        /^\p{Script=Latin}[\p{Script=Latin}\p{M}\p{N}]*$/u.test(run.text)
      ) &&
      Math.min(...runs.map((run) => run.size)) >=
        Math.max(...runs.map((run) => run.size)) * 0.8;

    // A left tab whose fitted text ends exactly at the writing boundary can
    // wrap in Word even when the source widths fit. Anchor that final field
    // by its measured right edge, preserving the glyph width and font size.
    // Restrict this to a single native source line with a known LTR field.
    const terminalTab =
      this.preserveSourceLines &&
      paragraph.source === "pdf" &&
      paragraph.lineCount === 1 &&
      paragraph.align === "left" &&
      !marker &&
      terminalRun?.tabBefore !== undefined &&
      terminalRun.width !== undefined &&
      terminalRun.width > 0 &&
      (terminalRun.width <= availableWidth * 0.2 ||
        // A single unbroken field can be wider on a small source page.
        // Keep long prose continuations on the existing left-tab path.
        (terminalRun.width <= availableWidth * 0.5 &&
          /^\p{L}[\p{L}\p{M}\p{N}]*$/u.test(terminalRun.text))) &&
      !terminalRun.fraction &&
      runs.every(
        (run) =>
          run.font === terminalRun.font &&
          (run.size === terminalRun.size || mixedSizeFieldHeading) &&
          !run.baselineShift &&
          !run.fraction &&
          !/\p{Sm}/u.test(run.text)
      ) &&
      !/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]/u.test(
        terminalRun.text
      ) &&
      Math.abs(
        terminalRun.tabBefore +
          terminalRun.width -
          left -
          (availableWidth - (paragraph.rightIndent ?? 0))
      ) <= 1.5
        ? terminalRun
        : undefined;
    // Tab stops belong to the paragraph, not to individual source lines.
    // A later row can introduce intermediate stops; one Tab would land on
    // those instead of the intended field. Traverse every intervening stop.
    const tabPositions = [
      ...new Set([
        ...(listIndent ? [listIndent.left] : []),
        ...paragraph.runs
          .filter((run) => run.tabBefore !== undefined)
          .map((run) => twips(run.tabBefore! - left)),
      ]),
    ]
      .sort((a, b) => a - b)
      .slice(0, 64);
    const measuredRows =
      this.preserveSourceLines &&
      paragraph.source === "pdf" &&
      (paragraph.lineCount ?? 1) > 1 &&
      !marker &&
      runs.every(
        (run) =>
          run.width !== undefined &&
          !run.fraction &&
          !run.baselineShift &&
          !/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]/u.test(
            run.text
          )
      );
    let sourceCursor = left + paragraph.indent + paragraph.firstIndent;
    return new SourceParagraph({
      frame,
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
        ...[
          ...(paragraph.backgroundImages ?? []),
          ...(paragraph.controlImages ?? []),
        ].map((image) =>
          this.image(image, image.width, {
            // Word resolves the column origin inside a cell after its padding;
            // cell paragraphs also omit the source paragraph space-before.
            horizontalPosition: {
              relative: inCell
                ? HorizontalPositionRelativeFrom.COLUMN
                : HorizontalPositionRelativeFrom.PAGE,
              offset: emu(image.x - (inCell ? left : 0)),
            },
            verticalPosition: {
              relative: VerticalPositionRelativeFrom.PARAGRAPH,
              offset: emu(
                (inCell ? 0 : Math.min(paragraph.before, 144)) +
                  image.y -
                  paragraph.y
              ),
            },
            allowOverlap: true,
            layoutInCell: inCell,
            behindDocument: image.behindText ?? false,
            wrap: { type: TextWrappingType.NONE },
          })
        ),
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
        ...runs.flatMap((run, index) => {
          const fonts = this.fonts.resolve(run.font);
          let width: number | undefined;
          let fallbackWidth: number | undefined;
          if (
            (paragraph.source === "pdf" || paragraph.source === "ocr") &&
            run.width !== undefined
          ) {
            let start = index,
              end = index + 1;
            while (
              start > 0 &&
              !runs[start].breakBefore &&
              !runs[start].sourceLineStart
            )
              start--;
            while (
              end < runs.length &&
              !runs[end].breakBefore &&
              !runs[end].sourceLineStart
            )
              end++;
            const lineWidth = runs
              .slice(start, end)
              .reduce((sum, item) => sum + (item.width ?? 0), 0);
            const indent = listIndent
              ? listIndent.left / 20
              : paragraph.indent + (start === 0 ? paragraph.firstIndent : 0);
            const available = Math.max(
              1,
              availableWidth - indent - (paragraph.rightIndent ?? 0) - 1.5
            );
            const lineText = runs
              .slice(start, end)
              .map((r) => r.text)
              .join("");
            // Some readers ignore autoSpaceDE/DN=false and add about 0.2 em at
            // script boundaries (verified by DOCX -> ODT/PDF inspection). Keep
            // the source fitText width for Word, with a bounded scaling fallback
            // for full mixed lines in readers that ignore fitText as well.
            const boundaries = [
              ...lineText.matchAll(
                /(?<=\p{Script=Han})(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])(?=\p{Script=Han})/gu
              ),
            ].length;
            const clearance =
              this.preserveSourceLines &&
              paragraph.source === "pdf" &&
              lineWidth >= available * 0.97 &&
              boundaries > 0
                ? Math.min(
                    lineWidth * 0.08,
                    boundaries *
                      Math.max(...runs.slice(start, end).map((r) => r.size)) *
                      0.2
                  )
                : 0;
            width = run.width * Math.min(1, available / Math.max(1, lineWidth));
            fallbackWidth =
              run.width *
              Math.min(1, (available - clearance) / Math.max(1, lineWidth));
          }
          const scale =
            width === undefined
              ? undefined
              : measuredScale(
                  run,
                  fallbackWidth ?? width,
                  this.fonts.measure(run, fonts)
                );
          if (index > 0 && run.breakBefore)
            sourceCursor = left + paragraph.indent;
          const tabCount =
            measuredRows && run.tabBefore !== undefined
              ? Math.max(
                  1,
                  tabPositions.filter(
                    (position) =>
                      position > twips(sourceCursor - left) &&
                      position <= twips(run.tabBefore! - left)
                  ).length
                )
              : 1;
          sourceCursor =
            (run.tabBefore ?? sourceCursor) + (width ?? run.width ?? 0);
          const value = textRun(
            run.tabBefore === undefined
              ? run
              : { ...run, tabBefore: undefined, breakBefore: false },
            fonts,
            scale,
            paragraph.source === "pdf" &&
              (scale === undefined || this.preserveSourceLines)
              ? width
              : undefined,
            ++this.fitId
          );
          // fitText must only measure glyphs. Including a tab in that same run
          // makes Word fit the tab advance as text and wrap the next glyphs.
          return run.tabBefore === undefined
            ? [value]
            : [
                new WordRun({
                  children: Array.from({ length: tabCount }, () => new Tab()),
                  break: run.breakBefore ? 1 : undefined,
                }),
                value,
              ];
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
      // Word rejects paragraphs with more than 64 tab definitions. Repeated
      // source rows reuse stops; keep a sorted, unique, bounded definition.
      tabStops: tabPositions.map((position) => ({
        type:
          terminalTab && position === twips(terminalTab.tabBefore! - left)
            ? TabStopType.RIGHT
            : TabStopType.LEFT,
        position:
          terminalTab && position === twips(terminalTab.tabBefore! - left)
            ? twips(terminalTab.tabBefore! + terminalTab.width! - left)
            : position,
      })),
      indent: marker
        ? listIndent
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
      keepNext:
        !this.preserveSourceLines && !inCell && paragraph.role === "heading",
      widowControl: !this.preserveSourceLines && paragraph.source !== "ocr",
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
    const tableBorder = table.borderless
      ? noBorder
      : table.border
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
                    textDirection:
                      cell.rotation === -90
                        ? TextDirection.BOTTOM_TO_TOP_LEFT_TO_RIGHT
                        : cell.rotation === 90
                          ? TextDirection.TOP_TO_BOTTOM_RIGHT_TO_LEFT
                          : undefined,
                    borders: table.borderless
                      ? Object.fromEntries(
                          ["top", "bottom"].map((edge) => {
                            const rule = table.horizontalBorders?.find(
                              (rule) =>
                                rule.boundary ===
                                (edge === "top" ? row : row + cell.rowSpan)
                            );
                            return [
                              edge,
                              rule
                                ? {
                                    style: BorderStyle.SINGLE,
                                    color: rule.color,
                                    size: Math.max(
                                      2,
                                      Math.round(rule.thickness * 8)
                                    ),
                                  }
                                : noBorder,
                            ];
                          })
                        )
                      : undefined,
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
                            (cell.rotation
                              ? table.rows.slice(
                                  cell.row,
                                  cell.row + cell.rowSpan
                                )
                              : table.columns.slice(
                                  cell.column,
                                  cell.column + cell.columnSpan
                                )
                            ).reduce((sum, width) => sum + width, 0) -
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
    if (block.role === "scan-region" || block.role === "graphic-region") {
      // An inline drawing inherits a font baseline/descent, which accumulates
      // across mixed text/image rows. Exact inline line height clips the image.
      // Anchor the crop to its own flowing paragraph and reserve its full height
      // instead; moving the paragraph in Word still moves the crop with it.
      const height =
        block.height * Math.min(1, (availableWidth - indent) / block.width);
      return new WordParagraph({
        run: { size: 2 },
        keepNext: false,
        widowControl: false,
        children: [
          ...(columnBreak ? [new ColumnBreak()] : []),
          this.image(block, availableWidth - indent, {
            horizontalPosition: {
              relative: HorizontalPositionRelativeFrom.COLUMN,
              offset: emu(indent),
            },
            verticalPosition: {
              relative: VerticalPositionRelativeFrom.PARAGRAPH,
              offset: emu(block.before),
            },
            allowOverlap: true,
            layoutInCell: true,
            behindDocument: false,
            wrap: { type: TextWrappingType.NONE },
          }),
          new WordRun({ text: "", size: 2 }),
        ],
        spacing: {
          before: positive(block.before),
          after: 0,
          line: positive(height),
          lineRule: LineRuleType.EXACT,
        },
      });
    }
    return new WordParagraph({
      children: [
        ...(columnBreak ? [new ColumnBreak()] : []),
        this.image(block, availableWidth - indent),
      ],
      indent: { left: positive(indent) },
      spacing: {
        before: positive(block.before),
        after: 0,
      },
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
  // Keep source flow for page-setup inference. Promoting a header must not
  // change the shared writing area on unrelated pages of the document.
  for (const page of pages) {
    const column =
      page.groups[0]?.columns.length === 1
        ? page.groups[0].columns[0]
        : undefined;
    const heading = column?.[0];
    if (!column || heading?.kind !== "paragraph" || !heading.sideHeading)
      continue;
    page.sideHeadings = [heading];
    column.shift();
    let cursor = page.margins.top;
    for (const block of column) {
      block.before = Math.max(0, block.y - cursor);
      cursor = Math.max(
        Math.max(cursor, block.y) +
          (block.kind === "paragraph"
            ? Math.max(block.height, (block.lineCount ?? 1) * block.lineHeight)
            : block.height),
        ...(block.kind === "paragraph"
          ? (block.floatingImages?.map(bottom) ?? [])
          : [])
      );
    }
  }
  if (options.preservePageBreaks) return pages;
  // Join only unambiguous single-column continuations. Keep original source
  // geometry in the analysis model; this adjustment applies to export only.
  for (let index = 1; index < pages.length; index++) {
    const previous = pages[index - 1],
      current = pages[index];
    if (
      previous.dropCaps?.length ||
      previous.sideHeadings?.length ||
      current.dropCaps?.length ||
      current.sideHeadings?.length ||
      previous.overlays?.some((image) => image.role === "scan-background") ||
      current.overlays?.some((image) => image.role === "scan-background") ||
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
    throw new Error("仍有未能完整讀取的頁面，請重新掃描文件內容。");
  if (!model.stats.characters && !model.stats.images)
    throw new Error("沒有可輸出的文字，請啟用 OCR 或改用文字型 PDF。");
  const writer = new Writer(options.preservePageBreaks);
  const sections: ISectionOptions[] = [];
  const setups = detectPageSetups(model.pages);
  const pages = prepareExportPages(model, options).map((page, index) =>
    applyPageSetup(page, setups[index])
  );
  pages.forEach(anchorFormControls);
  pages.forEach(anchorTextBackgrounds);
  let previousPage: PageModel | undefined;
  for (const page of pages) {
    const preservePage =
      options.preservePageBreaks ||
      !!page.dropCaps?.length ||
      !!page.sideHeadings?.length ||
      !!previousPage?.dropCaps?.length ||
      !!previousPage?.sideHeadings?.length ||
      page.overlays?.some((image) => image.role === "scan-background") ||
      previousPage?.overlays?.some((image) => image.role === "scan-background");
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
      if (groupIndex === 0)
        for (const cap of [
          ...(page.dropCaps ?? []),
          ...(page.sideHeadings ?? []),
        ])
          children.push(
            writer.paragraph(cap, false, false, cap.x, cap.width, [], {
              type: "absolute",
              position: { x: twips(cap.x), y: twips(cap.y) },
              anchor: {
                horizontal: FrameAnchorType.PAGE,
                vertical: FrameAnchorType.PAGE,
              },
              width: twips(cap.width),
              wrap: FrameWrap.NONE,
              anchorLock: true,
            })
          );
      // Word suppresses spacing-before on the first in-flow paragraph after
      // a floating frame. A minimal anchor retains the measured source gap.
      if (
        groupIndex === 0 &&
        (page.dropCaps?.length || page.sideHeadings?.length) &&
        !page.overlays?.length
      )
        children.push(
          new WordParagraph({
            children: [],
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
        // Word applies paragraph space-before ahead of an inline column
        // break, then drops it in the new column. A separate break paragraph
        // keeps source top spacing on the content paragraph that follows.
        const separateColumnBreak = Boolean(
          index &&
          (!blocks.length ||
            blocks[0].before > 1 ||
            blocks[0].kind === "table" ||
            // A rule has no inline runs to carry the column break.
            blocks[0].kind === "rule" ||
            blocks[0].kind === "image-row")
        );
        if (separateColumnBreak)
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
            // Word merges adjacent tables without an intervening paragraph,
            // even when their widths/indents differ. Keep independent grids.
            (block.before > 1 || children.at(-1) instanceof Table)
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
              index > 0 && blockIndex === 0 && !separateColumnBreak
            )
          );
        }
        columnLeft += columnWidth + (group.gaps?.[index] ?? group.gap);
      });
      const last = sections[sections.length - 1];
      const singleContinuation =
        last &&
        previousPage &&
        samePage(previousPage, page) &&
        !preservePage &&
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
                (preservePage ||
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
                          space:
                            index < columns - 1
                              ? positive(group.gaps?.[index] ?? group.gap)
                              : 0,
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
    compatibility: { noColumnBalance: true },
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
