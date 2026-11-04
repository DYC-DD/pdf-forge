import type { Box, PageModel, RawPage, TableModel } from "../types";
import { bottom, containsBox, right } from "./geometry";

type Vector = { box: Box; index: number; artwork: boolean };
const intersects = (a: Box, b: Box) =>
  Math.min(right(a), right(b)) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) > 0.5;

/** Retain small opaque rectangular label backgrounds without rasterizing text. */
export function textBackgrounds(
  raw: RawPage,
  vectors: Vector[],
  tables: TableModel[]
) {
  if (raw.source !== "pdf") return [];
  return (raw.fills ?? []).flatMap((fill) => {
    const vector = vectors.find(
      (v) => v.index === fill.paintOrder && !v.artwork
    );
    const rgb = /^[0-9A-F]{6}$/i.test(fill.color)
      ? [0, 2, 4].map((n) => parseInt(fill.color.slice(n, n + 2), 16))
      : [255, 255, 255];
    if (
      !vector ||
      !fill.opaque ||
      fill.width > 120 ||
      fill.height > 30 ||
      fill.width <= 3 ||
      fill.height <= 3 ||
      fill.width * fill.height > raw.width * raw.height * 0.01 ||
      Math.max(...rgb) > 128 ||
      tables.some((t) => intersects(t, fill))
    )
      return [];
    const spans = raw.spans.filter(
      (s) => !s.hidden && !s.rasterized && s.text.trim() && intersects(s, fill)
    );
    if (
      !spans.length ||
      spans.reduce((n, s) => n + s.text.length, 0) > 40 ||
      spans.some(
        (s) =>
          s.source !== "pdf" ||
          s.rotation ||
          s.color !== "FFFFFF" ||
          s.paintOrder === undefined ||
          s.paintOrder <= fill.paintOrder! ||
          !containsBox(fill, s, 1)
      ) ||
      Math.max(...spans.map((s) => s.baseline)) -
        Math.min(...spans.map((s) => s.baseline)) >
        1.5 ||
      raw.fills!.some(
        (other) =>
          other !== fill &&
          other.paintOrder! > fill.paintOrder! &&
          intersects(other, fill)
      )
    )
      return [];
    return [
      {
        ...fill,
        index: vector.index,
        ids: spans.flatMap((s) => s.ids ?? [s.id]),
      },
    ];
  });
}

export function anchorTextBackgrounds(page: PageModel): void {
  // Cell shading already has its own flow; rotated cells and footers are not
  // safe targets for this ordinary-paragraph coordinate system.
  const paragraphs = page.groups
    .flatMap((g) => g.columns.flat())
    .filter((b) => b.kind === "paragraph");
  page.overlays = page.overlays?.filter((image) => {
    if (!image.textBackgroundFor?.length || image.inFooter) return true;
    const candidates = paragraphs.filter(
      (p) =>
        p.source === "pdf" &&
        image.textBackgroundFor!.every((id) => p.ids.includes(id))
    );
    if (candidates.length !== 1) return true;
    (candidates[0].backgroundImages ??= []).push(image);
    return false;
  });
}
