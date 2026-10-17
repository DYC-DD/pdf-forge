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
  withPageNumber,
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
            entry.kind !== "rule" &&
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
  for (const [index, block] of arranged.entries()) {
    const next = arranged[index + 1];
    if (block.kind !== "paragraph" || !next || next.y <= block.y) continue;
    // A standalone source line has no measured leading. The default 1.25 em
    // must not accumulate when tightly set form rows are only one em apart.
    const count = block.lineCount ?? 1;
    const available = (next.y - block.y) / count;
    const minimum = Math.max(...block.runs.map((run) => run.size));
    if (available >= minimum && available < block.lineHeight)
      block.lineHeight = available;
  }
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
  if (
    nodes.some(
      (node) =>
        node.kind === "table" &&
        node.width > region.width * 0.8 &&
        node.height > region.height * 0.5
    )
  )
    return null;
  const narrow = lines.filter((line) => line.width < region.width * 0.62);
  if (narrow.length < 4 || lines.length - narrow.length > narrow.length * 0.4)
    return null;
  // Infer a gutter from rows that actually coexist. Projecting every line
  // onto the x axis lets a short centered title/affiliation bridge both columns
  // and erase the gutter for the entire page.
  const candidates = new Map<string, [number, number]>();
  for (let i = 0; i < narrow.length; i++) {
    const a = narrow[i];
    for (let j = i + 1; j < narrow.length; j++) {
      const b = narrow[j];
      if (b.y - bottom(a) > size * 1.5) break;
      if (Math.abs(a.baseline - b.baseline) > size * 1.5) continue;
      const [left, rightLine] = a.x < b.x ? [a, b] : [b, a];
      const start = right(left),
        end = rightLine.x;
      if (
        end - start >= Math.max(3, size * 0.25) &&
        start > region.x + region.width * 0.2 &&
        end < right(region) - region.width * 0.2
      )
        candidates.set(`${Math.round(start)}:${Math.round(end)}`, [start, end]);
    }
  }
  let best: { gap: [number, number]; score: number } | undefined;
  for (const gap of candidates.values()) {
    // A short rule joining both sides is a fill-in blank within a source row,
    // not a column gutter. Full-width section separators do not count.
    if (
      nodes.some(
        (node) =>
          node.kind === "rule" &&
          node.width < region.width * 0.65 &&
          node.x <= gap[0] + 2 &&
          right(node) >= gap[1] - 2
      )
    )
      continue;
    const left = narrow.filter((line) => right(line) <= gap[0] + 1);
    const rightLines = narrow.filter((line) => line.x >= gap[1] - 1);
    if (left.length < 2 || rightLines.length < 2) continue;
    // Paired one-line form labels do not establish independent reading columns.
    // Require consecutive source rows on both sides with a stable left edge.
    const hasProse = (entries: TextLine[]) =>
      entries.some((line, index) =>
        entries
          .slice(index + 1)
          .some(
            (next) =>
              next.baseline - line.baseline > size * 0.6 &&
              next.baseline - line.baseline <
                size *
                  (line.width > region.width * 0.32 &&
                  next.width > region.width * 0.32
                    ? 5
                    : 1.8) &&
              Math.abs(next.x - line.x) < size &&
              line.width > region.width * 0.2 &&
              next.width > region.width * 0.2
          )
      );
    if (!hasProse(left) || !hasProse(rightLines)) continue;
    const a = bounds(left),
      b = bounds(rightLines);
    const top = Math.max(a.y, b.y),
      end = Math.min(bottom(a), bottom(b));
    if (end - top <= Math.min(a.height, b.height) * 0.4) continue;
    const crossing = lines.filter(
      (line) =>
        line.y >= top &&
        bottom(line) <= end &&
        line.x < gap[1] - 1 &&
        right(line) > gap[0] + 1
    ).length;
    if (crossing > Math.max(2, (left.length + rightLines.length) * 0.15))
      continue;
    const score =
      Math.min(left.length, rightLines.length) * 4 +
      left.length +
      rightLines.length -
      crossing * 8;
    if (
      !best ||
      score > best.score ||
      (score === best.score && gap[1] - gap[0] < best.gap[1] - best.gap[0])
    )
      best = {
        gap: [
          Math.max(...left.map(right)),
          Math.min(...rightLines.map((line) => line.x)),
        ],
        score,
      };
  }
  return best?.gap ?? null;
}

function pageGroups(nodes: Node[], region: Box, bodySize: number): FlowGroup[] {
  // A narrow gutter can be smaller than an ordinary word space. Probe actual
  // span boundaries before inferring columns; otherwise joined left/right rows
  // hide the gutter and masquerade as full-width headings. Keep the original
  // nodes unless both sides establish independent prose in findColumnGap.
  const candidates = nodes
    .flatMap<Node>((node) => {
      if (node.kind !== "line") return [node];
      const groups: (typeof node.spans)[] = [];
      let edge = -Infinity;
      for (const span of node.spans) {
        const group = groups[groups.length - 1];
        if (!group || span.x - edge >= Math.max(3, bodySize * 0.25)) {
          groups.push([span]);
          edge = right(span);
        } else {
          group.push(span);
          edge = Math.max(edge, right(span));
        }
      }
      return groups.flatMap((spans) => buildLines(spans, true));
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  let gap = findColumnGap(candidates, region, bodySize);
  if (!gap) return [{ columns: [flow(nodes, region, bodySize)], gap: 0 }];
  // A page can have more than two independent reading columns. Search inside
  // each established side; spanning titles are excluded from that local probe.
  const collectGaps = (
    entries: Node[],
    box: Box,
    depth = 0
  ): [number, number][] => {
    const found = findColumnGap(entries, box, bodySize);
    if (!found || depth >= 2) return [];
    const left = { ...box, width: found[0] - box.x };
    const rightBox = { ...box, x: found[1], width: right(box) - found[1] };
    return [
      ...collectGaps(
        entries.filter((n) => right(n) <= found[0] + 1),
        left,
        depth + 1
      ),
      found,
      ...collectGaps(
        entries.filter((n) => n.x >= found[1] - 1),
        rightBox,
        depth + 1
      ),
    ];
  };
  const extraGaps = collectGaps(candidates, region);
  if (extraGaps.length > 1)
    return multiColumnGroups(nodes, region, bodySize, extraGaps);
  // Long source rows can narrow an established gutter below buildLines' wide
  // gap threshold. Split those rows at their actual span boundary before
  // treating them as full-width headings. Never cut an individual text span.
  const rightEdge = gap[1];
  nodes = nodes
    .flatMap<Node>((node) => {
      if (node.kind !== "line") return [node];
      const left = node.spans.filter((span) => span.x < rightEdge - 2);
      const rightSpans = node.spans.filter((span) => span.x >= rightEdge - 2);
      if (
        !left.length ||
        !rightSpans.length ||
        right(bounds(left)) + Math.max(3, bodySize * 0.25) >
          bounds(rightSpans).x
      )
        return [node];
      return [...buildLines(left, true), ...buildLines(rightSpans, true)];
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  gap = findColumnGap(nodes, region, bodySize) ?? gap;
  const [leftEnd, rightStart] = gap;
  const crossingRows = nodes.filter(
    (node) =>
      node.kind === "line" &&
      ((node.x < rightStart - Math.max(2, bodySize * 0.3) &&
        right(node) > leftEnd + Math.max(2, bodySize * 0.3)) ||
        // Dotted leaders connect a label and its field/value in the same row.
        /(?:\.\s*){4}/u.test(node.spans.map((span) => span.text).join("")))
  );
  const crossing = nodes
    .filter(
      (node) =>
        (node.x < rightStart - Math.max(2, bodySize * 0.3) &&
          right(node) > leftEnd + Math.max(2, bodySize * 0.3)) ||
        (node.kind === "line" &&
          crossingRows.some(
            (row) =>
              row.kind === "line" &&
              Math.abs(row.baseline - node.baseline) <
                Math.max(row.size, node.size) * 0.4
          ))
    )
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
    cursor = Math.max(
      cursor,
      ...entries.map((entry) =>
        entry.kind === "line"
          ? entry.y + Math.max(entry.height, entry.size * 1.25)
          : bottom(entry)
      )
    );
  };
  for (let index = 0; index < crossing.length; index++) {
    const node = crossing[index];
    band(node.y);
    const spanning = [node];
    // Keep consecutive full-width lines in one flow so title paragraphs and
    // the vertical spacing above the following columns survive section breaks.
    while (
      index + 1 < crossing.length &&
      ![...remaining].some((entry) => entry.y < crossing[index + 1].y)
    )
      spanning.push(crossing[++index]);
    groups.push({
      columns: [flow(spanning, { ...region, y: cursor }, bodySize)],
      gap: 0,
    });
    const last = spanning[spanning.length - 1];
    cursor =
      last.kind === "line"
        ? last.y + Math.max(last.height, last.size * 1.25)
        : bottom(last);
  }
  band(bottom(region) + 1);
  // A ruled form can alternate spanning text and isolated field rules many
  // times. Adjacent single-column bands need no new Word section; its terminal
  // paragraph would otherwise add height on every field row.
  const compact: FlowGroup[] = [];
  for (const group of groups) {
    const previous = compact[compact.length - 1];
    if (previous?.columns.length === 1 && group.columns.length === 1)
      previous.columns[0].push(...group.columns[0]);
    else compact.push(group);
  }
  return compact;
}

function multiColumnGroups(
  nodes: Node[],
  region: Box,
  bodySize: number,
  gaps: [number, number][]
): FlowGroup[] {
  // Pictures can be slightly wider than the text below them. Let them use
  // the gutter without misclassifying the picture as a spanning page heading.
  gaps = gaps.map(([start, end]) => [
    Math.max(
      start,
      ...nodes
        .filter((n) => n.kind === "image" && n.x < start && right(n) < end - 3)
        .map(right)
    ),
    end,
  ]);
  const edges = [region.x, ...gaps.map((g) => g[1])];
  const ends = [...gaps.map((g) => g[0]), right(region)];
  const split = nodes
    .flatMap<Node>((node) => {
      if (node.kind !== "line") return [node];
      const parts = edges.map((_, i) =>
        node.spans.filter(
          (s) =>
            s.x >= edges[i] - 2 &&
            (i === edges.length - 1 || s.x < edges[i + 1] - 2)
        )
      );
      // Do not split a title whose glyphs actually cross a gutter.
      if (
        parts.some(
          (spans, i) =>
            spans.length &&
            i < gaps.length &&
            right(bounds(spans)) > gaps[i][1] - 3
        )
      )
        return [node];
      return parts.flatMap((spans) => buildLines(spans, true));
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const spanning = split.filter((n) =>
    gaps.some(([a, b]) => n.x < b - 2 && right(n) > a + 2)
  );
  const remaining = new Set(split.filter((n) => !spanning.includes(n)));
  const result: FlowGroup[] = [];
  let cursor = region.y;
  const band = (end: number) => {
    const entries = [...remaining].filter((n) => n.y < end);
    if (!entries.length) return;
    entries.forEach((n) => remaining.delete(n));
    result.push({
      columns: edges.map((x, i) =>
        flow(
          entries.filter((n) => {
            const center = n.x + n.width / 2;
            return (
              (i === 0 || center >= (gaps[i - 1][0] + gaps[i - 1][1]) / 2) &&
              (i === gaps.length || center < (gaps[i][0] + gaps[i][1]) / 2)
            );
          }),
          { x, y: cursor, width: ends[i] - x, height: end - cursor },
          bodySize
        )
      ),
      widths: edges.map((x, i) => ends[i] - x),
      gap: gaps[0][1] - gaps[0][0],
      gaps: gaps.map(([a, b]) => b - a),
    });
    cursor = Math.max(
      cursor,
      ...entries.map((n) =>
        n.kind === "line" ? n.y + Math.max(n.height, n.size * 1.25) : bottom(n)
      )
    );
  };
  for (let i = 0; i < spanning.length; i++) {
    const entry = spanning[i];
    band(entry.y);
    const fullWidth = [entry];
    while (
      i + 1 < spanning.length &&
      ![...remaining].some((n) => n.y < spanning[i + 1].y)
    )
      fullWidth.push(spanning[++i]);
    result.push({
      columns: [flow(fullWidth, { ...region, y: cursor }, bodySize)],
      gap: 0,
    });
    const last = fullWidth[fullWidth.length - 1];
    cursor =
      last.kind === "line"
        ? last.y + Math.max(last.height, last.size * 1.25)
        : bottom(last);
  }
  band(bottom(region) + 1);
  return result;
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
    // A logo beside a native table shares the table's vertical band. Keeping
    // both in normal flow stacks them and pushes the bottom of the page out.
    // Anchor only isolated siblings whose full height fits that table band.
    const tableSiblings = new Set(
      figures.filter((figure) =>
        tables.some((table) => {
          if (
            Math.abs(figure.y - table.y) > 6 ||
            bottom(figure) > bottom(table) + 6 ||
            !(right(figure) + 6 <= table.x || right(table) + 6 <= figure.x)
          )
            return false;
          const box = bounds([figure, table]);
          return !text.some(
            (span) =>
              span.x < right(box) &&
              right(span) > box.x &&
              span.y < bottom(box) &&
              bottom(span) > box.y
          );
        })
      )
    );
    overlays.push(...tableSiblings);
    const nodes: Node[] = [
      ...buildLines(text),
      ...tables,
      ...rules,
      ...figures
        .filter((figure) => !tableSiblings.has(figure))
        .map((figure) => ({
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
    const groups = page.figures.some(
      (figure) => figure.role === "scan-background"
    )
      ? [{ columns: [flow(nodes, region, bodySize)], gap: 0 }]
      : pageGroups(nodes, region, bodySize);
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
        message: `已辨識 ${Math.max(...groups.map((group) => group.columns.length))} 欄，請核對閱讀順序與欄位分界。`,
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
            ...withPageNumber(
              makeParagraph(
                [footerLine],
                { x: 0, y: 0, width: page.width, height: page.height },
                bodySize
              )
            ),
            before: 0,
          }
        : undefined,
    };
  });
  return { pages, issues, stats };
}
