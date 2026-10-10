import type { Box, Paragraph, TextRun, TextSpan } from "../types";
import { bottom, bounds, median, right } from "./geometry";

export type TextLine = Box & {
  kind: "line";
  spans: TextSpan[];
  size: number;
  baseline: number;
};
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const opening = /[（「『【《〈(\[]$/u;
const closing = /^[，。！？；：、）》〉」』】,.!?;:)\]]/u;
const listPattern =
  /^(?:[•●▪◦‣–－-]|\d{1,3}[.)、](?!\d)|[（(]\d{1,3}[)）])\s*/u;
const chineseList =
  /^(?:[一二三四五六七八九十百]+[、．.]|[（(][一二三四五六七八九十百]+[)）])\s*/u;
const article = /^第[一二三四五六七八九十百\d]+條/u;

function sameScriptRow(a: TextSpan, b: TextSpan): boolean {
  if (a.source !== "pdf" || b.source !== "pdf") return false;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  const shift = Math.abs(small.baseline - large.baseline);
  return (
    small.size <= large.size * 0.82 &&
    shift >= large.size * 0.18 &&
    shift <= large.size * 0.65 &&
    Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) >= small.height * 0.3 &&
    Math.max(a.x, b.x) - Math.min(right(a), right(b)) <= large.size * 0.75
  );
}

function sameOcrRow(a: TextSpan, b: TextSpan): boolean {
  if (a.source !== "ocr" || b.source !== "ocr") return false;
  const [small, large] = a.height < b.height ? [a, b] : [b, a];
  // Thin clause markers and punctuation can have a different OCR baseline.
  // Attach only nearby fragments inside the taller word's vertical band.
  return (
    small.height <= large.height * 0.55 &&
    Array.from(small.text).length <= 3 &&
    small.width <= large.size * 2 &&
    Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) >= small.height * 0.5 &&
    Math.max(a.x, b.x) - Math.min(right(a), right(b)) <= large.size * 1.5
  );
}

export function paragraphText(paragraph: Paragraph): string {
  return paragraph.runs.reduce(
    (text, run) =>
      text +
      (run.breakBefore || run.tabBefore !== undefined
        ? joinSeparator(text, run.text)
        : "") +
      run.text,
    ""
  );
}

export function withPageNumber(paragraph: Paragraph): Paragraph {
  const text = paragraph.runs.map((run) => run.text).join("");
  // A total ("of 99", "共99頁") is literal source content. Only replace the
  // current-page token, and split styled runs if that token shares a run.
  const match =
    /^(?:\s*(?:第\s*|page\s*)?)(\d{1,4})(?=\s*(?:頁|of\b|[\/／]|$))/iu.exec(
      text
    );
  if (!match) {
    // A company footer may put an isolated page number after a wide tab.
    const trailing = paragraph.runs[paragraph.runs.length - 1];
    return trailing?.tabBefore !== undefined &&
      /^\d{1,4}$/u.test(trailing.text.trim())
      ? {
          ...paragraph,
          runs: paragraph.runs.map((run, index) =>
            index === paragraph.runs.length - 1
              ? { ...run, pageNumber: true }
              : run
          ),
        }
      : paragraph;
  }
  const start = match[0].length - match[1].length,
    end = start + match[1].length;
  let offset = 0;
  let field: TextRun | undefined;
  const part = (run: TextRun, from: number, to: number): TextRun => ({
    ...run,
    text: run.text.slice(from, to),
    width:
      run.width === undefined
        ? undefined
        : (run.width * (to - from)) / run.text.length,
    tabBefore: from ? undefined : run.tabBefore,
    breakBefore: from ? undefined : run.breakBefore,
    sourceLineStart: from ? undefined : run.sourceLineStart,
  });
  return {
    ...paragraph,
    runs: paragraph.runs.flatMap((run) => {
      const from = offset;
      offset += run.text.length;
      if (offset <= start || from >= end) return [run];
      const a = Math.max(0, start - from),
        b = Math.min(run.text.length, end - from);
      const token = part(run, a, b);
      const first = !field;
      if (!field) field = { ...token, text: match[1], pageNumber: true };
      else
        field.width =
          field.width === undefined || token.width === undefined
            ? undefined
            : field.width + token.width;
      return [
        ...(a ? [part(run, 0, a)] : []),
        ...(first ? [field] : []),
        ...(b < run.text.length ? [part(run, b, run.text.length)] : []),
      ];
    }),
  };
}

export function joinSeparator(previous: string, next: string): string {
  if (!previous || !next || /\s$/u.test(previous) || /^\s/u.test(next))
    return "";
  if (opening.test(previous) || closing.test(next)) return "";
  if (/[，。！？；：、）》〉」』】]$/u.test(previous) && cjk.test(next[0]))
    return "";
  if (cjk.test(previous.slice(-1)) && cjk.test(next[0])) return "";
  if (cjk.test(previous.slice(-1)) && /^[（「『【《〈]/u.test(next)) return "";
  if (/\p{L}[-\u00ad]$/u.test(previous) && /^\p{Ll}/u.test(next)) return "";
  return " ";
}

export function buildLines(
  spans: TextSpan[],
  joinWideGaps = false
): TextLine[] {
  const rows: TextSpan[][] = [];
  for (const span of [...spans].sort(
    (a, b) => a.baseline - b.baseline || a.x - b.x
  )) {
    const row = rows.slice(-4).find((candidate) => {
      const reference = candidate.reduce((a, b) => (b.size > a.size ? b : a));
      return (
        candidate.some(
          (entry) => entry.lineId && entry.lineId === span.lineId
        ) ||
        ((!reference.blockId ||
          !span.blockId ||
          reference.blockId === span.blockId ||
          (reference.source === "ocr" && span.source === "ocr")) &&
          (Math.abs(reference.baseline - span.baseline) <=
            Math.max(1.5, Math.min(reference.size, span.size) * 0.28) ||
            candidate.some(
              (entry) => sameOcrRow(entry, span) || sameScriptRow(entry, span)
            )))
      );
    });
    if (row) row.push(span);
    else rows.push([span]);
  }
  const lines: TextLine[] = [];
  const add = (group: TextSpan[]) => {
    if (!group.length) return;
    const maximum = Math.max(...group.map((span) => span.size));
    const main = group.filter((span) => span.size >= maximum * 0.85);
    lines.push({
      kind: "line",
      ...bounds(group),
      spans: group,
      size: median(main.map((span) => span.size)),
      baseline: median(main.map((span) => span.baseline)),
    });
  };
  for (const row of rows) {
    const sorted = row.sort((a, b) => a.x - b.x);
    let group: TextSpan[] = [];
    for (const span of sorted) {
      const previous = group[group.length - 1];
      if (
        previous &&
        !joinWideGaps &&
        span.x - right(previous) >
          Math.max(18, Math.min(previous.size, span.size) * 2.5)
      ) {
        add(group);
        group = [];
      }
      group.push(span);
    }
    add(group);
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function lineRuns(line: TextLine): TextRun[] {
  const runs: TextRun[] = [];
  let runStart = 0;
  for (const [index, span] of line.spans.entries()) {
    const baselineShift =
      span.source === "pdf" &&
      span.size < line.size * 0.85 &&
      Math.abs(line.baseline - span.baseline) > 1.5
        ? Math.round((line.baseline - span.baseline) * 2) / 2
        : undefined;
    const previousSpan = line.spans[index - 1];
    const tabBefore =
      previousSpan &&
      span.x - right(previousSpan) > Math.max(18, span.size * 2.5)
        ? span.x
        : undefined;
    let text = span.text;
    if (
      previousSpan &&
      tabBefore === undefined &&
      (previousSpan.spaceAfter ||
        span.x - right(previousSpan) >
          Math.min(span.size, previousSpan.size) * 0.16)
    ) {
      text = joinSeparator(previousSpan.text, text) + text;
    }
    const previous = runs[runs.length - 1];
    if (
      previous &&
      !previous.fraction &&
      !span.fraction &&
      tabBefore === undefined &&
      previous.bold === span.bold &&
      previous.italic === span.italic &&
      previous.color === span.color &&
      previous.fontScale === span.fontScale &&
      previous.underline === span.underline &&
      previous.baselineShift === baselineShift &&
      previous.font === span.font &&
      Math.abs(previous.size - span.size) < 0.1
    ) {
      previous.text += text;
      // OCR word boxes can overlap or nest. Summing their widths would invent
      // a wider line than the source, especially around digits and punctuation.
      previous.width = Math.max(previous.width ?? 0, right(span) - runStart);
    } else {
      runStart = span.x;
      runs.push({
        text,
        bold: span.bold,
        italic: span.italic,
        font: span.font,
        size: span.size,
        tabBefore,
        color: span.color,
        fontScale: span.fontScale,
        underline: span.underline,
        fraction: span.fraction,
        width: span.width,
        baselineShift,
      });
    }
  }
  return runs;
}

export function makeParagraph(
  lines: TextLine[],
  region: Box,
  bodySize: number,
  preserveLines = false
): Paragraph {
  const box = bounds(lines);
  const first = lines[0];
  const last = lines[lines.length - 1];
  const size = median(lines.map((line) => line.size));
  const runs: TextRun[] = [];
  const source = first.spans[0].source;
  for (const [lineIndex, line] of lines.entries()) {
    const next = lineRuns(line);
    if (runs.length && next.length) {
      const breakBefore =
        lineIndex > 0 &&
        (preserveLines ||
          source === "ocr" ||
          lines.every(
            (entry) =>
              Math.abs(
                entry.x + entry.width / 2 - (region.x + region.width / 2)
              ) < Math.max(3, size * 0.5)
          ));
      const separator = breakBefore
        ? ""
        : joinSeparator(runs[runs.length - 1].text, next[0].text);
      next[0] = {
        ...next[0],
        text: separator + next[0].text,
        breakBefore: breakBefore || undefined,
        sourceLineStart: true,
        lineSeparator: separator,
      };
    }
    runs.push(...next);
  }
  const text = runs.map((run) => run.text).join("");
  const isList = listPattern.test(text) || chineseList.test(text);
  const allBold = lines.every((line) => line.spans.every((span) => span.bold));
  const heading =
    !isList &&
    lines.length <= 2 &&
    (article.test(text) ||
      size > bodySize * 1.2 ||
      (allBold && box.width < region.width * 0.8));
  const lefts = lines.map((line) => line.x);
  const left = lines.length > 1 ? median(lefts.slice(1)) : first.x;
  const centerAligned =
    !runs.some((run) => run.tabBefore !== undefined) &&
    lines.every(
      (line) =>
        Math.abs(line.x + line.width / 2 - (region.x + region.width / 2)) <
        Math.max(3, size * 0.5)
    );
  const rightAligned = lines.every(
    (line) =>
      line.x >= region.x - 1 &&
      Math.abs(right(line) - right(region)) < Math.max(3, size * 0.5)
  );
  const justify =
    lines.length >= 3 &&
    lines.slice(0, -1).every((line) => line.width > region.width * 0.85);
  const align =
    centerAligned && box.width < region.width * 0.9
      ? "center"
      : rightAligned && box.width < region.width * 0.8
        ? "right"
        : justify
          ? "justify"
          : "left";
  return {
    ...box,
    kind: "paragraph",
    role: isList ? "list" : heading ? "heading" : "body",
    runs,
    ids: lines.flatMap((line) =>
      line.spans.flatMap((span) => span.ids ?? [span.id])
    ),
    align,
    before: 0,
    lineHeight:
      lines.length > 1
        ? median(
            lines
              .slice(1)
              .map((line, index) => line.baseline - lines[index].baseline)
          )
        : Math.max(
            size * 1.25,
            ...lines.flatMap((line) =>
              line.spans
                .filter((span) => span.fraction)
                .map((span) => span.height + 4)
            )
          ),
    indent: align === "center" || align === "right" ? 0 : left - region.x,
    firstIndent: first.x - left,
    lastLineWidth: last.width,
    source,
    lineCount: lines.length,
  };
}

export function groupParagraphs(
  lines: TextLine[],
  region: Box,
  bodySize: number,
  preserveLines = false
): Paragraph[] {
  const result: Paragraph[] = [];
  let current: TextLine[] = [];
  const finish = () => {
    if (!current.length) return;
    const paragraph = makeParagraph(current, region, bodySize, preserveLines);
    const previous = result[result.length - 1];
    paragraph.before = previous
      ? Math.max(0, paragraph.y - bottom(previous))
      : Math.max(0, paragraph.y - region.y);
    result.push(paragraph);
    current = [];
  };
  for (const line of lines) {
    const previous = current[current.length - 1];
    const text = lineRuns(line)
      .map((run) => run.text)
      .join("");
    if (previous) {
      const gap = line.baseline - previous.baseline;
      const reference = median(current.map((entry) => entry.size));
      const previousText = lineRuns(previous)
        .map((run) => run.text)
        .join("");
      const previousHeading = previous.size > bodySize * 1.2;
      const indent = line.x - region.x;
      const paragraphIndent =
        indent > reference * 0.8 &&
        Math.abs(previous.x - region.x) < reference * 0.5;
      const endOfParagraph =
        previous.width < region.width * 0.72 &&
        /[。！？.!?:：;；]$/u.test(previousText.trim());
      const previousParagraph = previous.spans[0].paragraphId;
      const currentParagraph = line.spans[0].paragraphId;
      const firstText = lineRuns(current[0])
        .map((run) => run.text)
        .join("");
      const hangingContinuation =
        (listPattern.test(firstText) || chineseList.test(firstText)) &&
        line.x >= current[0].x &&
        line.x - current[0].x <= reference * 5;
      if (
        (previousParagraph &&
          currentParagraph &&
          previousParagraph !== currentParagraph) ||
        gap > reference * 1.8 ||
        gap < reference * 0.55 ||
        Math.abs(line.size - reference) > reference * 0.18 ||
        listPattern.test(text) ||
        chineseList.test(text) ||
        article.test(text) ||
        article.test(previousText) ||
        previousHeading ||
        (paragraphIndent && !hangingContinuation) ||
        endOfParagraph ||
        (Math.abs(line.x - previous.x) > reference * 3 && !hangingContinuation)
      )
        finish();
    }
    current.push(line);
  }
  finish();
  return result;
}
