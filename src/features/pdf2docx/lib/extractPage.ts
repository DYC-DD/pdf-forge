import { OPS, type PDFPageProxy } from "pdfjs-dist";

import type { Box, Issue, RawPage, Rule, TextSpan } from "../types";
import { diagramGraphics } from "./diagramGraphics";
import { framedGraphics } from "./framedGraphics";
import {
  bottom,
  bounds,
  containsBox,
  containsCenter,
  median,
  right,
} from "./geometry";
import { transparentStamp } from "./imageAppearance";
import { checkAbort, DOCX_LIMITS } from "./limits";
import { deskewScan } from "./scanDeskew";
import { retainUncertainScan } from "./scanFallback";
import { detectTables } from "./tables";
import { applyTextAppearance, pdfFontName } from "./textAppearance";

type Matrix = [number, number, number, number, number, number];
type ImagePlacement = Box & {
  overlay?: boolean;
  blendMode?: string;
  textOperations?: number[];
  vectorOperations?: number[];
  behindText?: boolean;
  composite?: boolean;
  inFooter?: boolean;
  fullContent?: boolean;
  scanRegion?: boolean;
};
const identity: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: readonly number[], b: readonly number[]): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
const point = (matrix: readonly number[], x: number, y: number) => ({
  x: matrix[0] * x + matrix[2] * y + matrix[4],
  y: matrix[1] * x + matrix[3] * y + matrix[5],
});
function transformedBox(matrix: readonly number[], box: Box): Box {
  return bounds(
    [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ].map(([x, y]) => ({ ...point(matrix, x, y), width: 0, height: 0 }))
  );
}

export async function extractPage(
  page: PDFPageProxy,
  signal?: AbortSignal
): Promise<{ raw: RawPage; imageBoxes: ImagePlacement[] }> {
  const viewport = page.getViewport({ scale: 1 });
  const raw: RawPage = {
    number: page.pageNumber,
    width: viewport.width,
    height: viewport.height,
    spans: [],
    rules: [],
    figures: [],
    issues: [],
    source: "pdf",
    fills: [],
  };
  const issue = (
    code: string,
    message: string,
    severity: Issue["severity"] = "review"
  ) => {
    if (!raw.issues.some((entry) => entry.code === code))
      raw.issues.push({ page: page.pageNumber, code, message, severity });
  };
  // Loading the operator list also resolves embedded font metadata used below.
  const operators = await page.getOperatorList();
  checkAbort(signal);
  if (operators.fnArray.length > DOCX_LIMITS.operatorsPerPage)
    throw new Error(`第 ${page.pageNumber} 頁繪圖過於複雜，超過目前分析上限。`);
  const text = await page.getTextContent();
  checkAbort(signal);
  const angles = new Map<string, number>();
  for (const item of text.items) {
    if (!("str" in item) || !item.str) continue;
    if (raw.spans.length >= DOCX_LIMITS.spansPerPage)
      throw new Error(
        `第 ${page.pageNumber} 頁文字過於複雜，請選取較簡單的文件。`
      );
    const style = text.styles[item.fontName];
    const matrix = multiply(viewport.transform, item.transform);
    const size = Math.hypot(matrix[2], matrix[3]);
    const name = (
      page.commonObjs.has(item.fontName)
        ? page.commonObjs.get(item.fontName)?.name
        : ""
    ) as string | undefined;
    const font = pdfFontName(name || style?.fontFamily || "sans-serif");
    if (
      Math.abs(matrix[1]) > size * 0.15 ||
      item.dir === "ttb" ||
      item.dir === "rtl"
    )
      issue(
        "text-direction",
        "含直排、旋轉或由右至左的文字，請核對文字方向與閱讀順序。"
      );
    const width = Math.abs(
      item.width * Math.hypot(viewport.transform[0], viewport.transform[1])
    );
    const ascent = Number.isFinite(style?.ascent) ? style.ascent : 0.85;
    const span: TextSpan = {
      id: `${page.pageNumber}:pdf:${raw.spans.length}`,
      text: item.str,
      x: matrix[4],
      y: matrix[5] - size * ascent,
      width,
      height: size,
      baseline: matrix[5],
      size,
      font,
      bold: /bold|black|heavy|semibold|demi|Nimbus.*-Medi/iu.test(font),
      italic: /italic|oblique|ital$|slant/iu.test(font),
      source: "pdf",
      fontScale: Math.round(
        (Math.hypot(matrix[0], matrix[1]) / Math.max(0.01, size)) * 100
      ),
    };
    raw.spans.push(span);
    const rotation = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;
    if (Math.abs(Math.abs(rotation) - 90) < 1)
      span.rotation = rotation < 0 ? -90 : 90;
    angles.set(
      span.id,
      Math.abs((Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI)
    );
    // A rotated bounding box needs all four corners, not a horizontal width.
    if (Math.abs(matrix[1]) > size * 0.15) {
      const ux = matrix[0] / Math.hypot(matrix[0], matrix[1]),
        uy = matrix[1] / Math.hypot(matrix[0], matrix[1]);
      Object.assign(
        span,
        bounds(
          [0, width].flatMap((along) =>
            [ascent, ascent - 1].map((up) => ({
              x: matrix[4] + ux * along + matrix[2] * up,
              y: matrix[5] + uy * along + matrix[3] * up,
              width: 0,
              height: 0,
            }))
          )
        )
      );
    }
  }
  for (let index = 1; index < raw.spans.length; index++) {
    const space = raw.spans[index],
      previous = raw.spans[index - 1];
    if (
      !space.text.trim() &&
      space.width > 0 &&
      space.width < Math.max(18, space.size * 2.5) &&
      Math.abs(previous.baseline - space.baseline) < 1.5 &&
      Math.abs(right(previous) - space.x) < 1.5
    )
      previous.spaceAfter = true;
  }
  applyTextAppearance(raw.spans, operators);
  const regular = raw.spans.filter(
    (span) => (angles.get(span.id) ?? 0) < 10 && span.text.trim()
  );
  const bodySize = median(regular.map((span) => span.size));
  const regularCharacters = regular.reduce(
    (sum, item) => sum + item.text.length,
    0
  );
  const decorative = raw.spans.filter((span) => {
    const angle = angles.get(span.id) ?? 0;
    return (
      regularCharacters > 50 &&
      angle > 20 &&
      angle < 70 &&
      span.size > bodySize * 2
    );
  });
  decorative.forEach((span) => {
    span.decorative = true;
  });
  if (
    raw.spans.some((span) =>
      /[\uFFFD\u0000-\u0008\uE000-\uF8FF\p{Cn}]/u.test(span.text)
    )
  )
    issue(
      "encoding",
      "文字層含無法確認的字元，需要重新辨識並核對原稿。",
      "error"
    );
  const annotations = await page.getAnnotations({ intent: "display" });
  checkAbort(signal);
  const isolatedFields = new Map<(typeof annotations)[number], Box>();
  const visibleText = raw.spans.filter(
    (span) => !span.invisible && span.text.trim()
  );
  if (visibleText.reduce((sum, span) => sum + span.text.length, 0) >= 100) {
    for (const annotation of annotations) {
      if (
        annotation.subtype !== "Widget" ||
        annotation.fieldType !== "Tx" ||
        !String(annotation.fieldValue ?? "").trim() ||
        !Array.isArray(annotation.rect) ||
        annotation.rect.length !== 4 ||
        !annotation.rect.every(Number.isFinite)
      )
        continue;
      const [x1, y1, x2, y2] = annotation.rect;
      const box = transformedBox(viewport.transform, {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
      // Preserve the visible appearance of a small, isolated field. A value
      // in one cell must not discard a whole page of native editable text.
      if (
        box.width > 3 &&
        box.height > 3 &&
        box.width * box.height <= raw.width * raw.height * 0.05 &&
        box.height <= raw.height * 0.2 &&
        box.x >= 0 &&
        box.y >= 0 &&
        right(box) <= raw.width &&
        bottom(box) <= raw.height &&
        !visibleText.some(
          (span) =>
            span.x < right(box) &&
            right(span) > box.x &&
            span.y < bottom(box) &&
            bottom(span) > box.y
        )
      )
        isolatedFields.set(annotation, box);
    }
  }
  if (isolatedFields.size)
    issue(
      "annotation-region",
      "已保留局部表單欄位的原稿外觀；欄位內容為圖片，周圍文字仍可編輯，請核對相對位置。"
    );
  if (
    annotations.some(
      (annotation) =>
        annotation.subtype === "FreeText" ||
        (annotation.subtype === "Widget" &&
          !isolatedFields.has(annotation) &&
          // An unchecked PDF checkbox stores the name Off. It has no visible
          // value to recover and must not send an otherwise native form to OCR.
          !(
            annotation.fieldType === "Btn" && annotation.fieldValue === "Off"
          ) &&
          (Array.isArray(annotation.fieldValue)
            ? annotation.fieldValue.some((value: unknown) =>
                String(value).trim()
              )
            : String(annotation.fieldValue ?? "").trim()))
    )
  )
    issue(
      "annotations",
      "此頁含表單值或文字註解，文字層未包含全部可見內容，需要重新辨識並核對。",
      "error"
    );
  // Embedded fonts cannot be reused directly as Word fonts.
  issue(
    "font-substitution",
    "Word 會使用可用的對應字型；若裝置缺少原稿字型，換行與分頁可能不同。",
    "info"
  );
  const stack: Matrix[] = [];
  const paints: {
    fill: string;
    stroke: string;
    width: number;
    blendMode: string;
    opacity: number;
  }[] = [];
  let paintState = {
    fill: "000000",
    stroke: "000000",
    width: 1,
    blendMode: "source-over",
    opacity: 1,
  };
  let matrix = identity;
  let textMatrix = identity,
    fontSize = 0;
  const decorativeOperations: number[] = [];
  const imageBoxes: ImagePlacement[] = [];
  const vectorCandidates: { box: Box; index: number; artwork: boolean }[] = [];
  const addRule = (
    a: { x: number; y: number },
    b: { x: number; y: number }
  ) => {
    if (Math.abs(a.x - b.x) < 1.5 || Math.abs(a.y - b.y) < 1.5)
      raw.rules.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        color: paintState.stroke,
        thickness: paintState.width * Math.hypot(matrix[0], matrix[1]),
      });
    else
      issue(
        "vector-art",
        "含斜線或向量插圖；此開發版本尚未完整還原這類圖形，請核對原稿。"
      );
  };
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      paints.push({ ...paintState });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd)
      paintState = paints.pop() ?? {
        fill: "000000",
        stroke: "000000",
        width: 1,
        blendMode: "source-over",
        opacity: 1,
      };
    else if (op === OPS.setFillRGBColor && typeof args[0] === "string")
      paintState.fill = args[0].replace("#", "").toUpperCase();
    else if (op === OPS.setStrokeRGBColor && typeof args[0] === "string")
      paintState.stroke = args[0].replace("#", "").toUpperCase();
    else if (op === OPS.setLineWidth) paintState.width = args[0];
    else if (op === OPS.setGState) {
      for (const [key, value] of args[0])
        if (key === "BM") paintState.blendMode = value;
        else if (key === "ca") paintState.opacity = value;
    }
    if (op === OPS.setTextMatrix)
      textMatrix = args[0]?.length === 6 ? args[0] : args;
    else if (op === OPS.setFont) fontSize = Math.abs(args[1]);
    else if (op === OPS.showText && decorative.length) {
      const tm = multiply(multiply(viewport.transform, matrix), textMatrix);
      const angle = Math.abs((Math.atan2(tm[1], tm[0]) * 180) / Math.PI);
      if (
        angle > 20 &&
        angle < 70 &&
        fontSize * Math.hypot(tm[2], tm[3]) > bodySize * 2
      )
        decorativeOperations.push(index);
    }
    if (op === OPS.save) stack.push([...matrix]);
    else if (op === OPS.restore) matrix = stack.pop() ?? identity;
    else if (op === OPS.transform) matrix = multiply(matrix, args);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push([...matrix]);
      if (args[0]) matrix = multiply(matrix, args[0]);
    } else if (op === OPS.paintFormXObjectEnd) matrix = stack.pop() ?? identity;
    else if (
      op === OPS.paintImageXObject ||
      op === OPS.paintInlineImageXObject ||
      op === OPS.paintImageMaskXObject
    ) {
      imageBoxes.push({
        ...transformedBox(multiply(viewport.transform, matrix), {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        }),
        ...(paintState.blendMode === "multiply"
          ? { blendMode: "multiply" }
          : {}),
        ...(index < operators.fnArray.indexOf(OPS.showText)
          ? { behindText: true }
          : {}),
      });
    } else if (op === OPS.constructPath) {
      // PDF.js 6 uses packed DrawOPS: move=0, line=1, cubic=2, quadratic=3, close=4.
      // Pin the parser with real-PDF tests when upgrading PDF.js.
      const data = args[1]?.[0] as ArrayLike<number> | undefined;
      if (!data || typeof data.length !== "number") {
        issue("path-format", "部分向量路徑無法解析，表格與圖形可能需要檢查。");
        continue;
      }
      const transform = multiply(viewport.transform, matrix);
      let previous = { x: 0, y: 0 },
        first = previous;
      const paths: Rule[] = [];
      let curved = false;
      for (let cursor = 0; cursor < data.length;) {
        const command = data[cursor++];
        if (command === 0)
          first = previous = point(transform, data[cursor++], data[cursor++]);
        else if (command === 1) {
          const next = point(transform, data[cursor++], data[cursor++]);
          paths.push({
            x1: previous.x,
            y1: previous.y,
            x2: next.x,
            y2: next.y,
          });
          previous = next;
        } else if (command === 4) {
          paths.push({
            x1: previous.x,
            y1: previous.y,
            x2: first.x,
            y2: first.y,
          });
          previous = first;
        } else if (command === 2 || command === 3) {
          const count = command === 2 ? 6 : 4;
          previous = point(
            transform,
            data[cursor + count - 2],
            data[cursor + count - 1]
          );
          cursor += count;
          curved = true;
        } else {
          issue("path-format", "部分向量路徑無法解析，請核對圖形。");
          break;
        }
      }
      if (curved)
        issue(
          "vector-art",
          "含曲線或向量插圖；此開發版本尚未完整還原這類圖形，請核對原稿。"
        );
      const paint = args[0];
      const extent = args[2] as number[] | undefined;
      if (extent?.length === 4 && paint !== OPS.endPath) {
        const box = transformedBox(transform, {
          x: extent[0],
          y: extent[1],
          width: extent[2] - extent[0],
          height: extent[3] - extent[1],
        });
        const artwork =
          curved ||
          paths.some(
            (rule) =>
              Math.abs(rule.x1 - rule.x2) > 1.5 &&
              Math.abs(rule.y1 - rule.y2) > 1.5
          );
        const filled = [
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
        ].includes(paint);
        if (
          (artwork ||
            (filled && Math.min(box.width, box.height) > 3) ||
            box.y > raw.height * 0.92) &&
          !(
            filled &&
            paintState.fill === "FFFFFF" &&
            box.width * box.height > raw.width * raw.height * 0.9
          )
        )
          vectorCandidates.push({ box, index, artwork });
      }
      if (
        paint === OPS.stroke ||
        paint === OPS.closeStroke ||
        paint === OPS.fillStroke ||
        paint === OPS.eoFillStroke ||
        paint === OPS.closeFillStroke ||
        paint === OPS.closeEOFillStroke
      ) {
        paths.forEach((rule) =>
          addRule({ x: rule.x1, y: rule.y1 }, { x: rule.x2, y: rule.y2 })
        );
      }
      if (
        [
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
        ].includes(paint) &&
        !curved &&
        paths.length >= 3
      ) {
        const box = bounds(
          paths.flatMap((rule) => [
            { x: rule.x1, y: rule.y1, width: 0, height: 0 },
            { x: rule.x2, y: rule.y2, width: 0, height: 0 },
          ])
        );
        if (
          Math.min(box.width, box.height) <= 3 &&
          Math.max(box.width, box.height) > Math.min(box.width, box.height) * 4
        )
          raw.rules.push({
            x1: box.width > box.height ? box.x : box.x + box.width / 2,
            x2: box.width > box.height ? right(box) : box.x + box.width / 2,
            y1: box.width > box.height ? box.y + box.height / 2 : box.y,
            y2: box.width > box.height ? box.y + box.height / 2 : bottom(box),
            color: paintState.fill,
            thickness: Math.min(box.width, box.height),
          });
        else if (paths.length === 4)
          raw.fills!.push({
            ...box,
            color: paintState.fill,
            paintOrder: index,
            opaque:
              paintState.opacity === 1 &&
              paintState.blendMode === "source-over",
          });
        else issue("background", "含非矩形填色圖形，請核對視覺配置。");
      }
    } else if (
      op === OPS.paintImageXObjectRepeat ||
      op === OPS.paintImageMaskXObjectRepeat ||
      op === OPS.paintInlineImageXObjectGroup ||
      op === OPS.paintImageMaskXObjectGroup ||
      op === OPS.shadingFill
    )
      issue(
        "complex-art",
        "含重複圖片、遮罩或漸層，這些元素尚未完整還原，請核對。"
      );
    if (raw.rules.length > DOCX_LIMITS.rulesPerPage)
      throw new Error(
        `第 ${page.pageNumber} 頁線條過多，超過目前表格分析上限。`
      );
  }
  if (decorativeOperations.length)
    imageBoxes.push({
      ...bounds(decorative),
      textOperations: decorativeOperations,
    });
  else
    decorative.forEach((span) => {
      span.decorative = false;
    });
  // Some PDFs retain template text beneath a later opaque rectangle. Reading
  // that hidden text would invent content that is absent from the visible page.
  for (const span of raw.spans) {
    span.hidden =
      span.invisible ||
      raw.fills!.some(
        (fill) =>
          fill.opaque &&
          span.paintOrder !== undefined &&
          fill.paintOrder! > span.paintOrder &&
          fill.x <= span.x + 0.5 &&
          fill.y <= span.y + 0.5 &&
          right(fill) >= right(span) - 0.5 &&
          bottom(fill) >= bottom(span) - 0.5
      );
    if (/Wingdings/iu.test(span.font) && span.text === "l") span.text = "●";
  }
  const { tables } = detectTables(
    raw.rules,
    raw.spans.filter((span) => !span.hidden),
    bodySize,
    raw.fills
  );
  const vectors = vectorCandidates.filter(
    (candidate) =>
      candidate.artwork ||
      !tables.some((table) => containsCenter(table, candidate.box))
  );
  const charts = framedGraphics(
    raw,
    [...imageBoxes, ...vectors.map((v) => v.box)],
    tables
  );
  charts.push(
    ...diagramGraphics(
      raw,
      [...imageBoxes, ...vectors.map((v) => v.box)],
      tables,
      charts
    )
  );
  if (charts.length) {
    raw.spans.forEach((span) => {
      if (charts.some((box) => containsCenter(box, span)))
        span.rasterized = true;
    });
    raw.rules = raw.rules.filter(
      (r) =>
        !charts.some((box) =>
          containsBox(
            box,
            {
              x: Math.min(r.x1, r.x2),
              y: Math.min(r.y1, r.y2),
              width: Math.abs(r.x2 - r.x1),
              height: Math.abs(r.y2 - r.y1),
            },
            1
          )
        )
    );
    raw.fills = raw.fills?.filter(
      (fill) => !charts.some((box) => containsBox(box, fill, 1))
    );
    for (let i = imageBoxes.length - 1; i >= 0; i--)
      if (charts.some((box) => containsBox(box, imageBoxes[i], 2)))
        imageBoxes.splice(i, 1);
    imageBoxes.push(...charts.map((box) => ({ ...box, fullContent: true })));
    issue(
      "chart-image",
      "圖表與座標標籤保留為完整圖片，周圍正文仍可編輯。",
      "info"
    );
  }
  // Word paints a cell's shading over behind-text artwork, while an opaque
  // foreground photo hides editable lettering on that photo. Preserve only
  // small illustrated cells as one crop, keeping the surrounding grid native.
  const illustratedCells: Box[] = [];
  for (const table of tables) {
    for (const cell of table.cells) {
      const box = {
        x:
          table.x +
          table.columns.slice(0, cell.column).reduce((a, b) => a + b, 0),
        y: table.y + table.rows.slice(0, cell.row).reduce((a, b) => a + b, 0),
        width: table.columns
          .slice(cell.column, cell.column + cell.columnSpan)
          .reduce((a, b) => a + b, 0),
        height: table.rows
          .slice(cell.row, cell.row + cell.rowSpan)
          .reduce((a, b) => a + b, 0),
      };
      if (box.width * box.height > raw.width * raw.height * 0.05) continue;
      const labels = raw.spans.filter(
        (span) => !span.hidden && containsCenter(box, span)
      );
      if (labels.reduce((sum, span) => sum + span.text.length, 0) > 80)
        continue;
      const artwork =
        imageBoxes.some(
          (image) => !image.textOperations && containsBox(box, image, 1)
        ) ||
        vectors.some((v) => containsBox(box, v.box, 1)) ||
        labels.some((span) => {
          const angle = angles.get(span.id) ?? 0;
          return angle > 10 && angle < 80;
        });
      if (!artwork) continue;
      illustratedCells.push(box);
      labels.forEach((span) => {
        span.rasterized = true;
      });
    }
  }
  if (illustratedCells.length) {
    for (let i = imageBoxes.length - 1; i >= 0; i--)
      if (illustratedCells.some((box) => containsBox(box, imageBoxes[i], 1)))
        imageBoxes.splice(i, 1);
    imageBoxes.push(
      ...illustratedCells.map((box) => ({
        ...box,
        fullContent: true,
        overlay: true,
      }))
    );
    issue(
      "table-artwork",
      "表格中的局部圖像、標籤與斜向文字已保留原稿外觀；其他儲存格仍可編輯。",
      "info"
    );
  }
  const remainingVectors = vectors.filter(
    (v) =>
      ![...charts, ...illustratedCells].some((box) =>
        containsBox(box, v.box, 2)
      )
  );
  if (remainingVectors.length)
    imageBoxes.push({
      ...bounds(remainingVectors.map((entry) => entry.box)),
      vectorOperations: remainingVectors.map((entry) => entry.index),
      behindText: true,
    });
  for (const annotation of annotations) {
    const field = isolatedFields.get(annotation);
    if (field) {
      imageBoxes.push({ ...field, fullContent: true, overlay: true });
      continue;
    }
    if (
      annotation.subtype !== "Widget" ||
      annotation.fieldType !== "Btn" ||
      annotation.fieldValue !== "Off" ||
      !Array.isArray(annotation.rect)
    )
      continue;
    const [x1, y1, x2, y2] = annotation.rect;
    const box = transformedBox(viewport.transform, {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    });
    if (box.width > 0 && box.height > 0)
      imageBoxes.push({ ...box, fullContent: true, overlay: true });
  }
  return {
    raw,
    imageBoxes: imageBoxes.filter((box) => box.width > 3 && box.height > 3),
  };
}

export async function renderPage(
  page: PDFPageProxy,
  targetScale: number,
  signal?: AbortSignal,
  options?: {
    imagesOnly?: boolean;
    textOperations?: number[];
    vectorOperations?: number[];
    includeImages?: boolean;
  }
): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  checkAbort(signal);
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(
    targetScale,
    DOCX_LIMITS.renderEdge / original.width,
    DOCX_LIMITS.renderEdge / original.height,
    Math.sqrt(DOCX_LIMITS.renderPixels / (original.width * original.height))
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const isolated =
    options?.imagesOnly ||
    !!options?.textOperations ||
    !!options?.vectorOperations;
  const operators = isolated ? await page.getOperatorList() : undefined;
  const excluded = new Set([
    OPS.showText,
    OPS.showSpacedText,
    OPS.nextLineShowText,
    OPS.nextLineSetSpacingShowText,
    OPS.constructPath,
    OPS.shadingFill,
  ]);
  const selectedText = new Set(
    options?.textOperations ?? options?.vectorOperations
  );
  // getOperatorList() is unoptimized, whereas render() folds repeated images,
  // paths and text state operations. Its callback indexes a DIFFERENT list.
  // The optimizer preserves the order/count of text and path paint calls, so
  // select those by their ordinal, never by their raw operation index.
  const selectedPaint = new Map<number, Set<number>>();
  const sourceCounts = new Map<number, number>();
  operators?.fnArray.forEach((op, index) => {
    if (!excluded.has(op)) return;
    const ordinal = sourceCounts.get(op) ?? 0;
    sourceCounts.set(op, ordinal + 1);
    if (selectedText.has(index)) {
      if (!selectedPaint.has(op)) selectedPaint.set(op, new Set());
      selectedPaint.get(op)!.add(ordinal);
    }
  });
  const imagePaints = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObjectGroup,
  ]);
  const decisions: boolean[] = [];
  const renderCounts = new Map<number, number>();
  const filter = (index: number) => {
    // PDF.js currently exposes the executing list on RenderTask. Keep this
    // compatibility boundary local and fail explicitly if a future release
    // removes it, instead of silently dropping dependencies or drawing text.
    const list = (
      task as unknown as {
        _internalRenderTask?: {
          operatorList?: { fnArray: number[]; argsArray: unknown[][] };
        };
      }
    )._internalRenderTask?.operatorList;
    if (!list) throw new Error("無法安全擷取 PDF 圖層，請更新轉換工具後重試。");
    for (let i = decisions.length; i <= index; i++) {
      const op = list.fnArray[i];
      if (excluded.has(op)) {
        const ordinal = renderCounts.get(op) ?? 0;
        renderCounts.set(op, ordinal + 1);
        decisions[i] =
          !!selectedPaint.get(op)?.has(ordinal) ||
          (op === OPS.constructPath && list.argsArray[i]?.[0] === OPS.endPath);
      } else {
        decisions[i] =
          !!options?.includeImages ||
          (!options?.textOperations && !options?.vectorOperations) ||
          !imagePaints.has(op);
      }
    }
    return decisions[index];
  };
  const task = page.render({
    canvas,
    canvasContext: canvas.getContext("2d", { alpha: true })!,
    viewport,
    background: isolated ? "rgba(0,0,0,0)" : "#ffffff",
    operationsFilter: operators ? filter : undefined,
  });
  const abort = () => task.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await task.promise;
    checkAbort(signal);
    return { canvas, scale };
  } catch (error) {
    canvas.width = canvas.height = 0;
    checkAbort(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export function figureRegions(
  boxes: Box[],
  width: number,
  height: number,
  includeLarge = false
): Box[] {
  if (boxes.length > 1000)
    throw new Error("單頁圖片物件超過 1,000 個，請選取較簡單的文件。");
  const regions = boxes.flatMap((box) => {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite))
      return [];
    const x = Math.max(0, box.x),
      y = Math.max(0, box.y);
    const clipped = {
      x,
      y,
      width: Math.min(width, right(box)) - x,
      height: Math.min(height, bottom(box)) - y,
    };
    return clipped.width > 3 &&
      clipped.height > 3 &&
      (includeLarge || clipped.width * clipped.height < width * height * 0.7)
      ? [clipped]
      : [];
  });
  // PDFs often paint one illustration as overlapping masks or aligned tiles.
  // Crop their visible union once so those pieces do not become separate figures.
  for (let index = 0; index < regions.length; index++) {
    for (let other = index + 1; other < regions.length;) {
      const a = regions[index],
        b = regions[other];
      const overlapX = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
      const overlapY = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
      const overlapping = overlapX > 0.5 && overlapY > 0.5;
      const horizontalTile =
        overlapX >= -0.5 &&
        Math.abs(a.y - b.y) < 1 &&
        Math.abs(a.height - b.height) < 1;
      const verticalTile =
        overlapY >= -0.5 &&
        Math.abs(a.x - b.x) < 1 &&
        Math.abs(a.width - b.width) < 1;
      const union = bounds([a, b]);
      // An edge stamp touching a thin, page-wide address strip is not one
      // rectangular picture. Its bounding rectangle would cover unrelated text.
      const compact =
        union.width * union.height <=
        (a.width * a.height + b.width * b.height) * 1.15;
      if ((overlapping && compact) || horizontalTile || verticalTile) {
        regions[index] = union;
        regions.splice(other, 1);
        other = index + 1;
      } else other++;
    }
  }
  return regions;
}

export async function captureFigures(
  page: PDFPageProxy,
  raw: RawPage,
  boxes: ImagePlacement[],
  signal?: AbortSignal
): Promise<void> {
  const includeLarge = raw.source === "pdf";
  // A photograph crossing several OCR crops cannot be reconstructed as
  // independent flowing pictures without repeating/covering content. Keep the
  // original composition, clearing only complete reliable text paragraphs.
  if (
    !includeLarge &&
    boxes.some(
      (box) =>
        !box.textOperations &&
        !box.vectorOperations &&
        box.width * box.height > raw.width * raw.height * 0.15 &&
        box.width * box.height < raw.width * raw.height * 0.7 &&
        raw.figures.some(
          (figure) =>
            figure.role === "scan-region" &&
            Math.min(right(box), right(figure)) > Math.max(box.x, figure.x) &&
            Math.min(bottom(box), bottom(figure)) > Math.max(box.y, figure.y) &&
            !(
              figure.x <= box.x + 1 &&
              figure.y <= box.y + 1 &&
              right(figure) >= right(box) - 1 &&
              bottom(figure) >= bottom(box) - 1
            )
        )
    )
  ) {
    const { canvas, scale } = await renderPage(page, 3, signal);
    try {
      // OCR coordinates belong to its deskewed canvas, not the original tilt.
      if (raw.issues.some((issue) => issue.code === "scan-deskew"))
        deskewScan(canvas);
      await retainUncertainScan(
        canvas,
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height),
        scale,
        raw,
        signal
      );
    } finally {
      canvas.width = canvas.height = 0;
    }
    return;
  }
  const regions: ImagePlacement[] = [
    ...figureRegions(
      boxes.filter(
        (box) =>
          !box.textOperations && !box.vectorOperations && !box.fullContent
      ),
      raw.width,
      raw.height,
      includeLarge
    ),
    ...boxes.filter(
      (box) =>
        (box.textOperations || box.vectorOperations || box.fullContent) &&
        raw.source === "pdf"
    ),
  ];
  if (!includeLarge) {
    for (const box of regions) {
      if (box.width * box.height > raw.width * raw.height * 0.15) continue;
      // The image already contains its lettering. OCR text over a local logo
      // or callout is a second copy, even if the OCR score happens to be high.
      if (raw.figures.some((f) => !f.overlay && containsBox(f, box, 1)))
        continue;
      const intersecting = raw.figures.filter(
        (f) =>
          f.role === "scan-region" &&
          Math.min(right(f), right(box)) > Math.max(f.x, box.x) + 1 &&
          Math.min(bottom(f), bottom(box)) > Math.max(f.y, box.y) + 1
      );
      if (
        !intersecting.length &&
        !raw.spans.some((s) => containsCenter(box, s))
      )
        continue;
      Object.assign(box, bounds([box, ...intersecting]), {
        fullContent: true,
        scanRegion: true,
      });
      raw.figures = raw.figures.filter((f) => !intersecting.includes(f));
      raw.spans.forEach((s) => {
        if (containsCenter(box, s)) s.rasterized = true;
      });
      raw.rules = raw.rules.filter(
        (rule) =>
          !containsBox(box, {
            x: Math.min(rule.x1, rule.x2),
            y: Math.min(rule.y1, rule.y2),
            width: Math.abs(rule.x2 - rule.x1),
            height: Math.abs(rule.y2 - rule.y1),
          })
      );
    }
  }
  // Complex illustrated pages paint bitmaps and vector patches in alternating
  // order. Preserve that artwork as one local graphics layer, without body
  // text; independently stacking white bitmap backdrops would hide the paths.
  const vector = regions.find((box) => box.vectorOperations);
  const composite =
    vector &&
    raw.source === "pdf" &&
    !regions.some((box) => box.fullContent) &&
    !regions.some((box) => box.textOperations) &&
    regions.some(
      (box) =>
        !box.vectorOperations &&
        box.width * box.height > raw.width * raw.height * 0.35
    );
  if (composite) {
    const box = {
      ...bounds(regions),
      vectorOperations: vector.vectorOperations,
      behindText: true,
      composite: true,
    };
    const footer = raw.spans.filter(
      (span) => !span.hidden && span.text.trim() && span.y > raw.height * 0.92
    );
    if (footer.length && bottom(box) > raw.height * 0.92) {
      const cut = Math.min(...footer.map((span) => span.y)) - 8;
      regions.splice(
        0,
        regions.length,
        { ...box, height: cut - box.y },
        { ...box, y: cut, height: bottom(box) - cut, inFooter: true }
      );
    } else regions.splice(0, regions.length, box);
  }
  const candidates = regions.filter(
    (box, index) =>
      (includeLarge ||
        box.fullContent ||
        box.width * box.height < raw.width * raw.height * 0.7) &&
      !regions.some(
        (other, otherIndex) =>
          other !== box &&
          other.fullContent &&
          containsBox(other, box) &&
          (other.width * other.height > box.width * box.height ||
            otherIndex < index)
      ) &&
      // OCR crops already include original bitmap pixels. Do not insert the
      // same photograph again when its complete bounds are already retained.
      !raw.figures.some(
        (figure) =>
          !figure.overlay &&
          figure.x <= box.x + 1 &&
          figure.y <= box.y + 1 &&
          right(figure) >= right(box) - 1 &&
          bottom(figure) >= bottom(box) - 1
      )
  );
  if (
    (!includeLarge &&
      boxes.some(
        (box) => box.width * box.height >= raw.width * raw.height * 0.7
      )) ||
    regions.length > candidates.length
  )
    raw.issues.push({
      page: raw.number,
      code: "image-overlap",
      severity: "review",
      message: "掃描頁的背景圖片已交由 OCR 處理；其中圖像區域仍可能需要核對。",
    });
  if (candidates.length)
    raw.issues.push({
      page: raw.number,
      code: "image-text",
      severity: "info",
      message: "獨立圖片已保留原稿外觀，其中的文字無法直接編輯。",
    });
  if (!candidates.length) return;
  const sharedComposite = candidates.every(
    (box) =>
      box.composite && box.vectorOperations === candidates[0].vectorOperations
  );
  const { canvas, scale } = await renderPage(
    page,
    3,
    signal,
    sharedComposite
      ? {
          vectorOperations: candidates[0].vectorOperations,
          includeImages: true,
        }
      : { imagesOnly: true }
  );
  try {
    let total = 0;
    for (const box of candidates.slice(0, 50)) {
      checkAbort(signal);
      const x = Math.max(0, box.x),
        y = Math.max(0, box.y);
      const width = Math.min(box.x + box.width, raw.width) - x,
        height = Math.min(box.y + box.height, raw.height) - y;
      if (width <= 0 || height <= 0) continue;
      const crop = document.createElement("canvas");
      crop.width = Math.max(1, Math.ceil(width * scale));
      crop.height = Math.max(1, Math.ceil(height * scale));
      try {
        const context = crop.getContext("2d");
        if (!context) throw new Error("瀏覽器無法擷取圖片。");
        const isolated = box.fullContent
          ? await renderPage(page, scale, signal)
          : !sharedComposite && (box.textOperations || box.vectorOperations)
            ? await renderPage(page, scale, signal, {
                textOperations: box.textOperations,
                vectorOperations: box.vectorOperations,
                includeImages: box.composite,
              })
            : undefined;
        if (
          isolated &&
          box.scanRegion &&
          raw.issues.some((issue) => issue.code === "scan-deskew")
        )
          deskewScan(isolated.canvas);
        context.drawImage(
          isolated?.canvas ?? canvas,
          x * scale,
          y * scale,
          width * scale,
          height * scale,
          0,
          0,
          crop.width,
          crop.height
        );
        if (isolated) isolated.canvas.width = isolated.canvas.height = 0;
        if (box.composite) {
          // Composite graphics have a paper backdrop. JPEG preserves photo
          // detail at the working resolution without huge decoded PNGs.
          context.save();
          context.globalCompositeOperation = "destination-over";
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, crop.width, crop.height);
          context.restore();
        }
        // Multiply-mode stamps use white as a neutral backdrop. Encode that
        // backdrop as alpha so it cannot cover editable text in Word.
        const pixels = context.getImageData(0, 0, crop.width, crop.height);
        const stamp = transparentStamp(
          pixels.data,
          !box.textOperations &&
            !box.vectorOperations &&
            !box.fullContent &&
            raw.source === "pdf" &&
            raw.spans.filter((span) => containsCenter(box, span)).length >= 3,
          boxes.some(
            (source) =>
              source.blendMode === "multiply" && containsCenter(box, source)
          )
        );
        if (stamp) context.putImageData(pixels, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) =>
          crop.toBlob(
            (result) =>
              result
                ? resolve(result)
                : reject(new Error("無法保留頁面圖片。")),
            box.composite ? "image/jpeg" : "image/png",
            box.composite ? 0.94 : undefined
          )
        );
        total += blob.size;
        if (total > DOCX_LIMITS.imageBytes)
          throw new Error("圖片內容超過 32 MB，請先拆分 PDF 後再轉換。");
        raw.figures.push({
          x,
          y,
          width,
          height,
          id: `${raw.number}:image:${raw.figures.length}`,
          data: new Uint8Array(await blob.arrayBuffer()),
          format: box.composite ? "jpg" : "png",
          role: box.scanRegion
            ? "scan-region"
            : box.fullContent
              ? "graphic-region"
              : undefined,
          inFooter: box.inFooter,
          overlay:
            box.overlay ||
            (!box.fullContent &&
              (!!box.textOperations ||
                !!box.vectorOperations ||
                raw.spans.some((span) => containsCenter(box, span)))),
          behindText:
            stamp ||
            !!box.textOperations ||
            !!box.vectorOperations ||
            boxes.some(
              (source) =>
                (source.behindText || source.blendMode === "multiply") &&
                containsCenter(box, source)
            ),
        });
      } finally {
        crop.width = crop.height = 0;
      }
    }
    if (candidates.length > 50)
      raw.issues.push({
        page: raw.number,
        code: "image-limit",
        severity: "error",
        message: "單頁圖片超過 50 個，未能完整保留。",
      });
  } finally {
    canvas.width = canvas.height = 0;
  }
}
