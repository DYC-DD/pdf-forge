import type { TextRun } from "../types";

type MeasureContext = Pick<CanvasRenderingContext2D, "font" | "measureText">;
export type WordFonts = { ascii: string; hAnsi: string; eastAsia: string };
const eastAsian =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u2e80-\u303f\u31a0-\u33ff\ufe10-\ufe6f\uff01-\uff60≦≧]/u;
const kai = /DFKai|KaiShu|BiauKai|標楷|Kaiti|KaiTi/iu;
const ming = /ming|song|宋|明體|serif/iu;

export function fontName(font: string): string {
  if (/times|serif/iu.test(font) && !/sans/iu.test(font))
    return "Times New Roman";
  if (/courier|mono/iu.test(font)) return "Courier New";
  if (/^(?:sans-serif|Arial|Helvetica|Noto Sans CJK)/iu.test(font))
    return "Arial";
  return (
    font
      .replace(/^[A-Z]{6}\+/, "")
      .replace(
        /[-,]?(BoldItalic|Bold|Italic|Regular|Oblique|Roman|PSMT|MT)$/iu,
        ""
      ) || "Arial"
  );
}

function context(): MeasureContext | undefined {
  try {
    if (typeof OffscreenCanvas !== "undefined")
      return new OffscreenCanvas(1, 1).getContext("2d") ?? undefined;
    if (typeof document !== "undefined")
      return document.createElement("canvas").getContext("2d") ?? undefined;
  } catch {
    // Geometry and editable text remain available without font measurement.
  }
}

export function createFontResolver(ctx = context()) {
  const availability = new Map<string, boolean>();
  const fonts = new Map<string, WordFonts>();
  const available = (family: string) => {
    if (!ctx) return false;
    const cached = availability.get(family);
    if (cached !== undefined) return cached;
    const probe = (name: string) => {
      ctx.font = `12px ${name}`;
      return ["國語標點，。", "MWil0123"].map(
        (text) => ctx.measureText(text).width
      );
    };
    const serif = probe("serif"),
      mono = probe("monospace");
    const first = probe(`"${family}", serif`),
      second = probe(`"${family}", monospace`);
    const equal = (a: number[], b: number[]) =>
      a.every((value, i) => Math.abs(value - b[i]) < 0.01);
    const found =
      equal(first, second) && (!equal(first, serif) || !equal(second, mono));
    availability.set(family, found);
    return found;
  };
  const choose = (families: string[]) =>
    families.find(available) ?? families[0];
  const resolve = (source: string): WordFonts => {
    const cached = fonts.get(source);
    if (cached) return cached;
    const isKai = kai.test(source),
      isMing = ming.test(source) && !/sans/iu.test(source);
    const eastAsia = choose(
      isKai
        ? ["DFKai-SB", "BiauKai", "Kaiti TC", "KaiTi", "Noto Serif TC"]
        : isMing
          ? ["PMingLiU", "Songti TC", "SimSun", "Noto Serif TC"]
          : ["Microsoft JhengHei", "PingFang TC", "Heiti TC", "Noto Sans TC"]
    );
    const ascii = isKai
      ? eastAsia
      : isMing
        ? "Times New Roman"
        : fontName(source);
    const resolved = { ascii, hAnsi: ascii, eastAsia };
    fonts.set(source, resolved);
    return resolved;
  };
  const measure = (run: TextRun, face: WordFonts) => {
    if (!ctx || run.fraction || run.pageNumber) return undefined;
    if (
      !available(face.ascii) ||
      (eastAsian.test(run.text) && !available(face.eastAsia))
    )
      return undefined;
    let width = 0,
      text = "",
      asian: boolean | undefined;
    const flush = () => {
      if (!text) return;
      ctx.font = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${Math.round(run.size * 2) / 2}px "${asian ? face.eastAsia : face.ascii}"`;
      width += ctx.measureText(text).width;
      text = "";
    };
    for (const char of run.text) {
      const next = eastAsian.test(char);
      if (asian !== undefined && asian !== next) flush();
      asian = next;
      text += char;
    }
    flush();
    return Number.isFinite(width) && width > 0 ? width : undefined;
  };
  return { resolve, measure };
}

export function measuredScale(
  run: TextRun,
  width: number,
  measured: number | undefined
): number | undefined {
  if (!measured || width <= 0) return undefined;
  const scale = Math.floor((width / measured) * 100);
  // Reject implausible measurements rather than squeezing corrupt metadata.
  const original = run.fontScale ?? 100;
  return scale >= original * 0.5 && scale <= original * 2
    ? Math.max(10, Math.min(original, 300, scale))
    : undefined;
}
