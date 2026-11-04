import { readFile } from "node:fs/promises";

import { getDocument, OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";

// Compare widget-to-label geometry instead of absolute page coordinates:
// editable paragraphs can reflow, but each checkbox must stay with its label.
async function checkRenderedImages(
  source,
  rendered,
  checks,
  selection,
  assets,
  background = false
) {
  if (!checks.length) return [];
  const sourceTask = getDocument({
    data: new Uint8Array(await readFile(source)),
    ...assets,
  });
  const renderTask = getDocument({
    data: new Uint8Array(await readFile(rendered)),
    ...assets,
  });
  const normalize = (s) => s.normalize("NFKC").replace(/\s/gu, "");
  const used = new Set();
  try {
    const [original, converted] = await Promise.all([
      sourceTask.promise,
      renderTask.promise,
    ]);
    const results = [];
    for (const check of checks) {
      if (
        !Number.isInteger(check.page) ||
        check.page < 1 ||
        check.page > original.numPages ||
        typeof check.text !== "string" ||
        !normalize(check.text) ||
        (background
          ? !check.sourceBox ||
            ["x", "y", "width", "height"].some(
              (k) => !Number.isFinite(check.sourceBox[k])
            ) ||
            check.sourceBox.width <= 0 ||
            check.sourceBox.height <= 0
          : typeof check.fieldName !== "string" || !check.fieldName) ||
        !Number.isFinite(check.maxPositionError) ||
        check.maxPositionError < 0 ||
        (check.exactText !== undefined && typeof check.exactText !== "boolean")
      ) {
        throw new Error("Invalid form control render check");
      }
      const outputPage = selection.indexOf(check.page) + 1;
      const sp = await original.getPage(check.page);
      const sv = sp.getViewport({ scale: 1 });
      let box;
      if (background) {
        box = check.sourceBox;
        if (
          box.x < 0 ||
          box.y < 0 ||
          box.x + box.width > sv.width ||
          box.y + box.height > sv.height
        )
          throw new Error("Background outside source page");
      } else {
        const widget = (await sp.getAnnotations()).filter(
          (a) => a.fieldType === "Btn" && a.fieldName === check.fieldName
        );
        if (widget.length !== 1)
          throw new Error(
            `Source widget missing or ambiguous: ${check.fieldName}`
          );
        const rect = [...widget[0].rect];
        Util.applyTransform(rect, sv.transform);
        Util.applyTransform(rect, sv.transform, 2);
        box = {
          x: Math.min(rect[0], rect[2]),
          y: Math.min(rect[1], rect[3]),
          width: Math.abs(rect[2] - rect[0]),
          height: Math.abs(rect[3] - rect[1]),
        };
      }
      const labels = async (page, viewport, rendered = false) =>
        (await page.getTextContent()).items
          .filter(
            (i) =>
              typeof i.str === "string" &&
              (background && rendered
                ? i.str
                    .normalize("NFKC")
                    .trim()
                    .replace(/\s+/gu, " ")
                    .startsWith(check.text.trim() + " ") ||
                  normalize(i.str) === normalize(check.text)
                : check.exactText
                  ? normalize(i.str) === normalize(check.text)
                  : normalize(i.str).includes(normalize(check.text)))
          )
          .map((i) => Util.transform(viewport.transform, i.transform).slice(4));
      const sourceLabels = await labels(sp, sv);
      if (sourceLabels.length !== 1)
        throw new Error(
          `Source control label missing or ambiguous: ${check.text}`
        );
      let error = Infinity;
      if (outputPage > 0 && outputPage <= converted.numPages) {
        const rp = await converted.getPage(outputPage),
          rv = rp.getViewport({ scale: 1 });
        const renderLabels = await labels(rp, rv, true);
        if (renderLabels.length === 1) {
          const target = {
            x: renderLabels[0][0] + box.x - sourceLabels[0][0],
            y: renderLabels[0][1] + box.y - sourceLabels[0][1],
          };
          const ops = await rp.getOperatorList();
          let matrix = [1, 0, 0, 1, 0, 0];
          const stack = [],
            candidates = [];
          ops.fnArray.forEach((op, i) => {
            if (op === OPS.save) stack.push([...matrix]);
            else if (op === OPS.restore)
              matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
            else if (op === OPS.transform)
              matrix = Util.transform(matrix, ops.argsArray[i]);
            else if (
              [
                OPS.paintImageXObject,
                OPS.paintInlineImageXObject,
                OPS.paintImageMaskXObject,
              ].includes(op)
            ) {
              const key = `${outputPage}:${i}`;
              if (used.has(key)) return;
              const m = Util.transform(rv.transform, matrix);
              const points = [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 1],
              ].map((p) => {
                Util.applyTransform(p, m);
                return p;
              });
              const x = Math.min(...points.map((p) => p[0])),
                y = Math.min(...points.map((p) => p[1]));
              const width = Math.max(...points.map((p) => p[0])) - x,
                height = Math.max(...points.map((p) => p[1])) - y;
              // A large background or unrelated artwork cannot satisfy a checkbox.
              if (
                Math.abs(width - box.width) <= 0.5 &&
                Math.abs(height - box.height) <= 0.5
              )
                candidates.push({
                  key,
                  error: Math.max(
                    Math.abs(x - target.x),
                    Math.abs(y - target.y)
                  ),
                });
            }
          });
          candidates.sort((a, b) => a.error - b.error);
          if (candidates.length) {
            error = candidates[0].error;
            if (error <= check.maxPositionError) used.add(candidates[0].key);
          }
        }
      }
      results.push({
        text: check.text,
        error,
        pass: error <= check.maxPositionError,
      });
    }
    return results;
  } finally {
    await Promise.all([sourceTask.destroy(), renderTask.destroy()]);
  }
}

// Source boxes are manually verified against a SHA-pinned PDF, in viewport points.
export function checkRenderedControls(...args) {
  return checkRenderedImages(...args);
}
export function checkRenderedBackgrounds(...args) {
  return checkRenderedImages(...args, true);
}
