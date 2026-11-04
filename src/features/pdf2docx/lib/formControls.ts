import type { Box, PageModel, Paragraph } from "../types";
import { bottom, containsBox, right } from "./geometry";

type Label = { paragraph: Paragraph; cell?: Box; rotated?: boolean };

/** Bind only small, unambiguous widgets; keep other artwork page anchored. */
export function anchorFormControls(page: PageModel): void {
  const paragraphs: Label[] = page.groups.flatMap((group) =>
    group.columns.flatMap((column) =>
      column.flatMap<Label>((block) =>
        block.kind === "paragraph"
          ? [{ paragraph: block }]
          : block.kind === "table"
            ? block.cells.flatMap((cell) =>
                cell.paragraphs.map((paragraph) => ({
                  paragraph,
                  rotated: !!cell.rotation,
                  cell: {
                    x:
                      block.x +
                      block.columns
                        .slice(0, cell.column)
                        .reduce((a, b) => a + b, 0),
                    y:
                      block.y +
                      block.rows.slice(0, cell.row).reduce((a, b) => a + b, 0),
                    width: block.columns
                      .slice(cell.column, cell.column + cell.columnSpan)
                      .reduce((a, b) => a + b, 0),
                    height: block.rows
                      .slice(cell.row, cell.row + cell.rowSpan)
                      .reduce((a, b) => a + b, 0),
                  },
                }))
              )
            : []
      )
    )
  );
  page.overlays = page.overlays?.filter((image) => {
    if (
      !image.formControl ||
      image.inFooter ||
      image.width > 18 ||
      image.height > 18
    )
      return true;
    const cy = image.y + image.height / 2;
    const candidates = paragraphs.filter(
      ({ paragraph: p, cell }) =>
        p.source === "pdf" &&
        p.runs.length &&
        (!cell || containsBox(cell, image, 1)) &&
        cy >= p.y - 2 &&
        cy <= bottom(p) + 2 &&
        image.x <= right(p) + 18 &&
        right(image) >= p.x - 18
    );
    // A page may have adjacent labels/cells on the same baseline. Do not
    // guess when more than one paragraph could own the control.
    if (candidates.length !== 1) return true;
    const candidate = candidates[0];
    // Rotated cells use a different text coordinate system. A control outside
    // the source cell must not move into it merely because a label is nearby.
    if (candidate.rotated) return true;
    const { paragraph } = candidates[0];
    (paragraph.controlImages ??= []).push(image);
    return false;
  });
}
