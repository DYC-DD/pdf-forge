import type {
  Box,
  DocumentModel,
  FlowBlock,
  FlowGroup,
  ImageBlock,
  PageModel,
  Paragraph,
  RawPage,
} from "../types";
import { bottom, bounds, median, right } from "./geometry";
import { classifyPage, recurringFooterIds } from "./pageObjects";
import {
  buildLines,
  groupParagraphs,
  makeParagraph,
  type TextLine,
} from "./paragraphs";

type Node = TextLine | Exclude<FlowBlock, Paragraph>;
function groupImages(nodes: Node[]): Node[] {
  const remaining = new Set(nodes);
  const result: Node[] = [];
  for (const node of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!remaining.delete(node)) continue;
    if (node.kind !== "image") {
      result.push(node);
      continue;
    }
    const images: ImageBlock[] = [node];
    for (const other of remaining) {
      if (other.kind !== "image") continue;
      const overlap =
        Math.min(bottom(node), bottom(other)) - Math.max(node.y, other.y);
      if (
        overlap < Math.min(node.height, other.height) * 0.7 ||
        Math.abs(node.y - other.y) >
          Math.max(6, Math.min(node.height, other.height) * 0.15) ||
        images.some((image) => image.x < right(other) && other.x < right(image))
      )
        continue;
      const box = bounds([...images, other]);
      // A row of pictures must not swallow text located between the pictures.
      if (
        nodes.some(
          (entry) =>
            entry.kind !== "image" &&
            entry.x < right(box) &&
            right(entry) > box.x &&
            entry.y < bottom(box) &&
            bottom(entry) > box.y
        )
      )
        continue;
      images.push(other);
      remaining.delete(other);
    }
    result.push(
      images.length === 1
        ? node
        : {
            ...bounds(images),
            kind: "image-row",
            before: 0,
            images: images.sort((a, b) => a.x - b.x),
          }
    );
  }
  return result;
}

function attachWrappedImages(blocks: FlowBlock[]): FlowBlock[] {
  const attached = new Set<FlowBlock>();
  for (const image of blocks) {
    if (image.kind !== "image") continue;
    const paragraph = blocks.find(
      (entry): entry is Paragraph =>
        entry.kind === "paragraph" &&
        entry.role === "body" &&
        !entry.floatingImages?.length &&
        Math.abs(entry.y - image.y) <= Math.max(6, entry.runs[0].size * 0.6) &&
        Math.min(bottom(entry), bottom(image)) - Math.max(entry.y, image.y) >=
          Math.min(entry.height, image.height) * 0.7 &&
        (right(entry) + 6 <= image.x || right(image) + 6 <= entry.x)
    );
    if (!paragraph) continue;
    paragraph.floatingImages = [image];
    // Let Word's native wrapping establish the side clearance. Keeping the
    // source side indent as well would apply the same clearance twice.
    paragraph.indent = 0;
    paragraph.firstIndent = 0;
    paragraph.align = "left";
    attached.add(image);
  }
  return blocks.filter((block) => !attached.has(block));
}

function flow(nodes: Node[], region: Box, bodySize: number): FlowBlock[] {
  const output: FlowBlock[] = [];
  let lines: TextLine[] = [];
  const flush = () => {
    // Column boundaries have already been resolved; retain side-by-side fields
    // on a shared baseline as tabbed runs instead of adding a new text row.
    const combined = buildLines(
      lines.flatMap((line) => line.spans),
      true
    );
    output.push(...groupParagraphs(combined, region, bodySize));
    lines = [];
  };
  for (const node of groupImages(nodes).sort(
    (a, b) => a.y - b.y || a.x - b.x
  )) {
    if (node.kind === "line") lines.push(node);
    else {
      flush();
      output.push(node);
    }
  }
  flush();
  const arranged = attachWrappedImages(output);
  let cursor = region.y;
  for (const block of arranged) {
    block.before = Math.max(0, block.y - cursor);
    cursor = Math.max(
      cursor,
      block.kind === "paragraph"
        ? block.y +
            Math.max(block.height, (block.lineCount ?? 1) * block.lineHeight)
        : bottom(block),
      ...(block.kind === "paragraph"
        ? (block.floatingImages?.map(bottom) ?? [])
        : [])
    );
  }
  return arranged;
}

function findColumnGap(
  nodes: Node[],
  region: Box,
  size: number
): [number, number] | null {
  const lines = nodes.filter((node): node is TextLine => node.kind === "line");
  const narrow = lines.filter((line) => line.width < region.width * 0.62);
  if (narrow.length < 4 || lines.length - narrow.length > narrow.length * 0.4)
    return null;
  const intervals = narrow
    .map((line) => [line.x, right(line)])
    .sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  const gaps = merged
    .slice(1)
    .map((interval, index) => [merged[index][1], interval[0]])
    .filter(
      ([a, b]) =>
        b - a >= Math.max(18, size * 1.5) &&
        a > region.x + region.width * 0.2 &&
        b < right(region) - region.width * 0.2
    )
    .sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  for (const gap of gaps) {
    const left = narrow.filter((line) => right(line) <= gap[0] + 1);
    const rightLines = narrow.filter((line) => line.x >= gap[1] - 1);
    if (left.length < 2 || rightLines.length < 2) continue;
    const a = bounds(left),
      b = bounds(rightLines);
    if (
      Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) >
      Math.min(a.height, b.height) * 0.4
    )
      return gap as [number, number];
  }
  return null;
}

function pageGroups(nodes: Node[], region: Box, bodySize: number): FlowGroup[] {
  const gap = findColumnGap(nodes, region, bodySize);
  if (!gap) return [{ columns: [flow(nodes, region, bodySize)], gap: 0 }];
  const [leftEnd, rightStart] = gap;
  const crossing = nodes
    .filter((node) => node.x < rightStart && right(node) > leftEnd)
    .sort((a, b) => a.y - b.y);
  const remaining = new Set(nodes.filter((node) => !crossing.includes(node)));
  const groups: FlowGroup[] = [];
  let cursor = region.y;
  const band = (end: number) => {
    const entries = [...remaining].filter((node) => node.y < end);
    if (!entries.length) return;
    entries.forEach((node) => remaining.delete(node));
    const left = entries.filter(
      (node) => node.x + node.width / 2 < (leftEnd + rightStart) / 2
    );
    const rightNodes = entries.filter((node) => !left.includes(node));
    if (!left.length || !rightNodes.length)
      groups.push({
        columns: [flow(entries, { ...region, y: cursor }, bodySize)],
        gap: 0,
      });
    else
      groups.push({
        columns: [
          flow(
            left,
            {
              x: region.x,
              y: cursor,
              width: leftEnd - region.x,
              height: end - cursor,
            },
            bodySize
          ),
          flow(
            rightNodes,
            {
              x: rightStart,
              y: cursor,
              width: right(region) - rightStart,
              height: end - cursor,
            },
            bodySize
          ),
        ],
        gap: rightStart - leftEnd,
        widths: [leftEnd - region.x, right(region) - rightStart],
      });
  };
  for (const node of crossing) {
    band(node.y);
    groups.push({
      columns: [flow([node], { ...region, y: node.y }, bodySize)],
      gap: 0,
    });
    cursor =
      node.kind === "line"
        ? node.y + Math.max(node.height, node.size * 1.25)
        : bottom(node);
  }
  band(bottom(region) + 1);
  return groups;
}

export function analyzeLayout(rawPages: RawPage[]): DocumentModel {
  const recurring = recurringFooterIds(rawPages);
  const scanBounds = rawPages
    .filter((page) => page.source === "ocr" && page.spans.length >= 100)
    .map((page) => ({ page, box: bounds(page.spans) }));
  const issues = rawPages.flatMap((page) => page.issues);
  const stats = {
    pages: rawPages.length,
    characters: 0,
    paragraphs: 0,
    tables: 0,
    images: 0,
    ocrPages: 0,
    rules: 0,
  };
  const pages: PageModel[] = rawPages.map((page) => {
    const {
      spans,
      bodySize,
      footerLine,
      footerIds,
      tables,
      lines: rules,
      text,
      figures,
      overlays,
    } = classifyPage(page, recurring);
    const nodes: Node[] = [
      ...buildLines(text),
      ...tables,
      ...rules,
      ...figures.map((figure) => ({
        ...figure,
        kind: "image" as const,
        before: 0,
      })),
    ];
    const content = bounds(nodes);
    const margins = nodes.length
      ? {
          left: Math.max(0, Math.min(content.x, page.width * 0.3)),
          right: Math.max(
            0,
            Math.min(page.width - right(content), page.width * 0.3)
          ),
          top: Math.max(0, Math.min(content.y, page.height * 0.2)),
          bottom: Math.max(
            0,
            Math.min(page.height - bottom(content), page.height * 0.2)
          ),
        }
      : { left: 36, right: 36, top: 36, bottom: 36 };
    if (page.source === "ocr" && spans.length < 100) {
      const references = scanBounds.filter(
        ({ page: other }) =>
          Math.abs(page.width - other.width) < 3 &&
          Math.abs(page.height - other.height) < 3
      );
      if (references.length) {
        margins.left = Math.min(
          margins.left,
          median(references.map(({ box }) => box.x))
        );
        margins.right = Math.min(
          margins.right,
          median(references.map(({ page, box }) => page.width - right(box)))
        );
      }
    }
    const region = {
      x: margins.left,
      y: margins.top,
      width: page.width - margins.left - margins.right,
      height: page.height - margins.top - margins.bottom,
    };
    const groups = pageGroups(nodes, region, bodySize);
    const represented = new Set<string>([
      ...footerIds,
      ...page.spans
        .filter(
          (span) =>
            !span.text.trim() ||
            span.decorative ||
            span.hidden ||
            span.rasterized
        )
        .map((span) => span.id),
    ]);
    stats.images += overlays.length;
    stats.rules += rules.length;
    if (footerLine) stats.paragraphs++;
    for (const block of groups.flatMap((group) => group.columns.flat())) {
      if (block.kind === "paragraph") {
        stats.paragraphs++;
        stats.images += block.floatingImages?.length ?? 0;
        block.ids.forEach((id) => represented.add(id));
      }
      if (block.kind === "table") {
        stats.tables++;
        block.cells.forEach((cell) =>
          cell.paragraphs.forEach((paragraph) =>
            paragraph.ids.forEach((id) => represented.add(id))
          )
        );
      }
      if (block.kind === "image") stats.images++;
      if (block.kind === "image-row") stats.images += block.images.length;
    }
    if (represented.size !== page.spans.length)
      issues.push({
        page: page.number,
        code: "coverage",
        severity: "error",
        message: "部分文字未能建立文件結構，請檢查原稿。",
      });
    if (groups.some((group) => group.columns.length > 1))
      issues.push({
        page: page.number,
        code: "columns",
        severity: "review",
        message: "已辨識雙欄，請核對閱讀順序與欄位分界。",
      });
    const characters = spans.reduce(
      (sum, span) => sum + span.text.replace(/\s/gu, "").length,
      0
    );
    stats.characters += characters;
    if (page.source === "ocr") stats.ocrPages++;
    return {
      number: page.number,
      width: page.width,
      height: page.height,
      margins,
      groups,
      source: page.source,
      characters,
      overlays: overlays.map((figure) => ({
        ...figure,
        kind: "image",
        before: 0,
      })),
      classification: {
        source:
          page.source === "ocr" ? "scan" : spans.length ? "native" : "image",
        text: text.length,
        tables: tables.length,
        rules: rules.length,
        images: figures.length + overlays.length,
      },
      footer: footerLine
        ? {
            ...makeParagraph(
              [footerLine],
              { x: 0, y: 0, width: page.width, height: page.height },
              bodySize
            ),
            runs: makeParagraph(
              [footerLine],
              { x: 0, y: 0, width: page.width, height: page.height },
              bodySize
            ).runs.map((run) => ({
              ...run,
              pageNumber: /^\d{1,4}$/u.test(run.text.trim()),
            })),
            before: 0,
          }
        : undefined,
    };
  });
  return { pages, issues, stats };
}
