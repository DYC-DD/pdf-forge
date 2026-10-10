import type {
  FlowBlock,
  MarginPreset,
  PageModel,
  PaperSize,
  Paragraph,
} from "../types";
import { bottom, bounds, median, right } from "./geometry";

const mm = (value: number) => (value * 72) / 25.4;
export const PAPER_SIZES = {
  a4: { width: mm(210), height: mm(297) },
  a3: { width: mm(297), height: mm(420) },
  a5: { width: mm(148), height: mm(210) },
  letter: { width: 612, height: 792 },
};
export const MARGIN_PRESETS = {
  narrow: { top: 36, bottom: 36, left: 36, right: 36 },
  standard: { top: 72, bottom: 72, left: 90, right: 90 },
};

export type DetectedPageSetup = {
  paperSize: PaperSize;
  width: number;
  height: number;
  marginPreset: MarginPreset | "detected";
  margins: PageModel["margins"];
};

function detectPaper(
  page: PageModel
): Omit<DetectedPageSetup, "margins" | "marginPreset"> {
  const width = Math.min(page.width, page.height),
    height = Math.max(page.width, page.height);
  // Match physical dimensions, not only aspect ratio: a cropped scan with an A4
  // ratio is not evidence that its original physical paper was A4.
  const match = Object.entries(PAPER_SIZES)
    .map(([name, size]) => ({
      name,
      size,
      error: Math.max(
        Math.abs(width - size.width) / size.width,
        Math.abs(height - size.height) / size.height
      ),
    }))
    .filter(
      ({ size }) =>
        Math.abs(width - size.width) <= Math.max(3, size.width * 0.01) &&
        Math.abs(height - size.height) <= Math.max(3, size.height * 0.01)
    )
    .sort((a, b) => a.error - b.error)[0];
  const size = match?.size ?? { width, height };
  return {
    paperSize: match ? (match.name as PaperSize) : "source",
    width: page.width > page.height ? size.height : size.width,
    height: page.width > page.height ? size.width : size.height,
  };
}

type MarginEvidence = Partial<PageModel["margins"]> & {
  reliableWidth: boolean;
};
function marginEvidence(page: PageModel): MarginEvidence {
  const blocks = page.groups.flatMap((group) => group.columns.flat());
  const text = blocks
    .filter(
      (block): block is Paragraph =>
        block.kind === "paragraph" &&
        block.role !== "heading" &&
        block.align !== "center" &&
        block.align !== "right"
    )
    .map((paragraph) =>
      paragraph.floatingImages?.length
        ? { ...paragraph, ...bounds([paragraph, ...paragraph.floatingImages]) }
        : paragraph
    );
  const tables = blocks.filter((block) => block.kind === "table");
  const anchors = [...text, ...tables];
  if (!anchors.length) return { reliableWidth: false };
  const lefts = [
    ...anchors,
    ...blocks.filter(
      (block) =>
        block.kind === "paragraph" &&
        block.role === "heading" &&
        block.align === "left"
    ),
  ]
    .map((block) => block.x)
    .sort((a, b) => a - b);
  // Prefer body starts over indented lists, quotes, and isolated decorations.
  const left = Math.max(0, lefts[Math.floor((lefts.length - 1) * 0.05)]);
  const wide = anchors.filter(
    (block) =>
      block.width >= page.width * 0.5 &&
      (block.kind === "table" ||
        block.height > block.lineHeight * 1.5 ||
        block.align === "justify")
  );
  const columnEdges = page.groups
    .filter((group) => group.columns.length > 1)
    .flatMap((group) => group.columns.flat())
    .filter((block) => block.kind === "paragraph" || block.kind === "table");
  const rightEdges = [...wide, ...columnEdges].map(right);
  const first = Math.min(...blocks.map((block) => block.y));
  const last = Math.max(
    ...anchors.map((block) =>
      block.kind === "paragraph"
        ? block.y +
          4 +
          Math.max(block.height, (block.lineCount ?? 1) * block.lineHeight)
        : bottom(block)
    )
  );
  return {
    left,
    // A short line supplies no evidence for the right writing boundary.
    right: rightEdges.length
      ? Math.max(0, page.width - Math.max(...rightEdges))
      : undefined,
    top: first <= page.height * 0.18 ? Math.max(0, first) : undefined,
    bottom:
      page.height - last <= page.height * 0.18
        ? Math.max(0, page.height - last)
        : undefined,
    reliableWidth: rightEdges.length > 0,
  };
}

function chooseMargins(
  pages: readonly PageModel[]
): Pick<DetectedPageSetup, "margins" | "marginPreset"> {
  const evidence = pages.map(marginEvidence);
  const edges = ["left", "right", "top", "bottom"] as const;
  const observed: Partial<PageModel["margins"]> = {};
  for (const edge of edges) {
    const grounded = evidence.filter(
      (entry) => entry.reliableWidth && entry[edge] !== undefined
    );
    const values = (grounded.length ? grounded : evidence).flatMap((entry) =>
      entry[edge] === undefined ? [] : [entry[edge]!]
    );
    if (values.length)
      observed[edge] =
        edge === "top" || edge === "bottom"
          ? values.sort((a, b) => a - b)[Math.floor((values.length - 1) * 0.2)]
          : median(values);
  }
  const weights = { left: 2, right: 1.5, top: 0.5, bottom: 0.5 };
  const scores = (["standard", "narrow"] as const)
    .map((preset) => {
      let cost = 0,
        weight = 0;
      for (const edge of edges) {
        if (observed[edge] === undefined) continue;
        const delta = observed[edge]! - MARGIN_PRESETS[preset][edge];
        // Tolerate small glyph/line offsets around a common preset, but penalize
        // a boundary that would cut deeply into the source writing area.
        const loss =
          delta < -20
            ? 3 + (-delta - 20) / 12
            : Math.min(Math.abs(delta), 60) / 20;
        cost += loss * weights[edge];
        weight += weights[edge];
      }
      return { preset, cost: weight ? cost / weight : 0 };
    })
    .sort((a, b) => a.cost - b.cost);
  const best = scores[0];
  if (best.cost <= 1.5 || !evidence.some((entry) => entry.reliableWidth)) {
    const margins = { ...MARGIN_PRESETS[best.preset] };
    let adjusted = false;
    for (const edge of ["top", "bottom"] as const) {
      const values = evidence.flatMap((entry) =>
        entry[edge] === undefined ? [] : [entry[edge]!]
      );
      const safe = Math.min(...values);
      // A familiar preset is a prior, not permission to push real content onto
      // another page. Physical coordinates need enough writing height on every
      // page, including the last row of a dense landscape register.
      const tableAtBottom =
        edge === "bottom" &&
        pages.some((page) =>
          page.groups.some((group) =>
            group.columns.some((blocks) =>
              blocks.some(
                (block) =>
                  block.kind === "table" &&
                  page.height - bottom(block) < margins.bottom + 3
              )
            )
          )
        );
      if (safe < margins[edge] - 3 || tableAtBottom) {
        margins[edge] = Math.max(0, Math.floor(safe - 3));
        adjusted = true;
      }
    }
    return {
      marginPreset: adjusted ? "detected" : best.preset,
      margins,
    };
  }
  // Preserve well-supported nonstandard margins instead of forcing all PDFs
  // into a preset. Unobserved top/bottom edges still use the closest prior.
  const margins = { ...MARGIN_PRESETS[best.preset] };
  const width = median(pages.map((page) => page.width)),
    height = median(pages.map((page) => page.height));
  for (const edge of edges)
    if (observed[edge] !== undefined)
      margins[edge] =
        Math.round(
          Math.min(
            observed[edge]!,
            edge === "left" || edge === "right" ? width * 0.35 : height * 0.2
          ) * 2
        ) / 2;
  return { marginPreset: "detected", margins };
}

export function detectPageSetups(
  pages: readonly PageModel[]
): DetectedPageSetup[] {
  const papers = pages.map(detectPaper);
  const keys = papers.map(
    (paper) =>
      `${paper.paperSize}:${Math.round(paper.width)}:${Math.round(paper.height)}`
  );
  const groups = new Map<string, PageModel[]>();
  pages.forEach((page, index) =>
    groups.set(keys[index], [...(groups.get(keys[index]) ?? []), page])
  );
  const margins = new Map(
    [...groups].map(([key, entries]) => [key, chooseMargins(entries)])
  );
  return papers.map((paper, index) => ({
    ...paper,
    ...margins.get(keys[index])!,
  }));
}

export function pageSetupLabel(setup: DetectedPageSetup): string {
  const paper =
    setup.paperSize === "source"
      ? "原稿尺寸"
      : setup.paperSize === "letter"
        ? "Letter"
        : setup.paperSize.toUpperCase();
  const direction = setup.width > setup.height ? "橫向" : "直向";
  const margins =
    setup.marginPreset === "standard"
      ? "標準邊界"
      : setup.marginPreset === "narrow"
        ? "窄邊界"
        : "依內容辨識的邊界";
  return `${paper} ${direction}・${margins}`;
}

// Source coordinates stay intact in the analysis model. Only export geometry is
// mapped into the chosen writing area; type size stays editable and readable.
export function applyPageSetup(
  page: PageModel,
  setup: DetectedPageSetup = detectPageSetups([page])[0]
): PageModel {
  const output = structuredClone(page);
  output.width = setup.width;
  output.height = setup.height;
  output.margins = { ...setup.margins };
  // PDF coordinates describe the physical page, including sparse covers.
  // Moving every page's own content bounds to the new margin would expand a
  // cover and collapse its large white areas. Preserve page coordinates instead.
  {
    const sx = output.width / page.width,
      sy = output.height / page.height;
    const map = (
      block: FlowBlock,
      sourceLeft: number,
      targetLeft: number,
      availableWidth: number,
      sourceWidth = availableWidth / sx
    ): FlowBlock => {
      const box = {
        x: block.x * sx,
        y: block.y * sy,
        width: block.width * sx,
        height: block.height * sy,
        before: block.before * sy,
      };
      if (block.kind === "paragraph") {
        const paragraphLeft = (sourceLeft + block.indent) * sx;
        return {
          ...block,
          ...box,
          indent: paragraphLeft - targetLeft,
          firstIndent: block.firstIndent * sx,
          rightIndent:
            targetLeft + availableWidth - (sourceLeft + sourceWidth) * sx,
          lastLineWidth: block.lastLineWidth * sx,
          runs: block.runs.map((run) => ({
            ...run,
            width: run.width === undefined ? undefined : run.width * sx,
            tabBefore:
              run.tabBefore === undefined ? undefined : run.tabBefore * sx,
          })),
          floatingImages: block.floatingImages?.map(
            (image) =>
              map(image, sourceLeft, targetLeft, availableWidth) as typeof image
          ),
        };
      }
      if (block.kind === "table")
        return {
          ...block,
          ...box,
          columns: block.columns.map((value) => value * sx),
          rows: block.rows.map((value) => value * sy),
          cells: block.cells.map((cell) => ({
            ...cell,
            padding: cell.padding && {
              left: cell.padding.left * sx,
              right: cell.padding.right * sx,
            },
            paragraphs: cell.paragraphs.map(
              (p) =>
                map(
                  p,
                  block.x +
                    block.columns
                      .slice(0, cell.column)
                      .reduce((sum, value) => sum + value, 0) +
                    (cell.padding?.left ?? 3),
                  (block.x +
                    block.columns
                      .slice(0, cell.column)
                      .reduce((sum, value) => sum + value, 0)) *
                    sx +
                    (cell.padding?.left ?? 3) * sx,
                  block.columns
                    .slice(cell.column, cell.column + cell.columnSpan)
                    .reduce((sum, value) => sum + value, 0) *
                    sx -
                    ((cell.padding?.left ?? 3) + (cell.padding?.right ?? 3)) *
                      sx
                ) as Paragraph
            ),
          })),
        };
      if (block.kind === "image-row")
        return {
          ...block,
          ...box,
          images: block.images.map(
            (image) =>
              map(image, sourceLeft, targetLeft, availableWidth) as typeof image
          ),
        };
      if (block.kind === "image") {
        const factor = Math.min(
          1,
          availableWidth / Math.max(1, box.width),
          Math.max(
            1,
            output.height - output.margins.top - output.margins.bottom - 24
          ) / Math.max(1, box.height)
        );
        return {
          ...block,
          ...box,
          width: box.width * factor,
          height: box.height * factor,
        };
      }
      return { ...block, ...box };
    };
    output.groups = page.groups.map((group) => {
      let sourceLeft = page.margins.left,
        targetLeft = output.margins.left;
      const width = output.width - output.margins.left - output.margins.right;
      return {
        ...group,
        gap: group.gap * sx,
        widths: group.widths?.map((value) => value * sx),
        columns: group.columns.map((blocks, index) => {
          const availableWidth = group.widths?.[index]
            ? group.widths[index] * sx
            : width;
          const mapped = blocks.map((block) =>
            map(
              block,
              sourceLeft,
              targetLeft,
              availableWidth,
              group.widths?.[index] ??
                page.width - page.margins.left - page.margins.right
            )
          );
          sourceLeft += (group.widths?.[index] ?? width) + group.gap;
          targetLeft += availableWidth + group.gap * sx;
          return mapped;
        }),
      };
    });
    if (page.footer)
      output.footer = {
        ...(map(
          page.footer,
          0,
          output.margins.left,
          output.width - output.margins.left - output.margins.right,
          page.width
        ) as Paragraph),
        before: 0,
      };
    output.overlays = page.overlays?.map((image) => ({
      ...image,
      x: image.x * sx,
      y: image.y * sy,
      width: image.width * sx,
      height: image.height * sy,
    }));
    // First blocks are positioned relative to the selected Word top margin.
    for (const blocks of output.groups[0]?.columns ?? [])
      if (blocks[0])
        blocks[0].before = Math.max(0, blocks[0].y - output.margins.top);
    return output;
  }
}
