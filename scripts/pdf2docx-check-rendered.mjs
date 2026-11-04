import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  checkRenderedBackgrounds,
  checkRenderedControls,
} from "./pdf2docx-render-controls.mjs";
import { textAnchors } from "./pdf2docx-text-anchors.mjs";

// Accept the Word helper's <output>/<id>.pdf and render_docx.py's nested path.
// Check actual rendered pages and optional source text anchors, not section counts.
const manifest =
  process.env.PDF2DOCX_CORPUS_MANIFEST ?? process.env.PDF2DOCX_PRIVATE_MANIFEST;
const output = process.env.PDF2DOCX_QA_DIR;
if (!manifest || !output)
  throw new Error(
    "Set PDF2DOCX_CORPUS_MANIFEST (or PDF2DOCX_PRIVATE_MANIFEST) and PDF2DOCX_QA_DIR first."
  );
const samples = JSON.parse(await readFile(resolve(manifest), "utf8"));
const assets = {
  standardFontDataUrl: fileURLToPath(
    new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)
  ).replaceAll("\\", "/"),
  cMapUrl: fileURLToPath(
    new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url)
  ).replaceAll("\\", "/"),
  cMapPacked: true,
};
if (!Array.isArray(samples) || !samples.length)
  throw new Error("The manifest must contain at least one PDF sample.");

async function pages(path) {
  const task = getDocument({
    data: new Uint8Array(await readFile(path)),
    ...assets,
  });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}

const normalize = (text) => text.normalize("NFKC").replace(/\s/gu, "");
async function anchors(path, pageNumber, text) {
  const task = getDocument({
    data: new Uint8Array(await readFile(path)),
    ...assets,
  });
  try {
    const page = await (await task.promise).getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    return textAnchors(
      content.items
        .filter((item) => "str" in item)
        .map((item) => {
          const transform = Util.transform(viewport.transform, item.transform);
          return {
            text: item.str,
            x: transform[4],
            y: transform[5],
            width: item.width,
            height: item.height,
            dir: item.dir,
          };
        }),
      text
    ).sort((a, b) => a.y - b.y || a.x - b.x);
  } finally {
    await task.destroy();
  }
}

let failed = false;
for (const sample of samples) {
  if (!/^[a-z0-9-]+$/.test(sample.id)) throw new Error("Invalid sample ID.");
  const source = await pages(sample.path);
  if (
    sample.pages &&
    (!Array.isArray(sample.pages) ||
      !sample.pages.length ||
      sample.pages.some(
        (page) => !Number.isInteger(page) || page < 1 || page > source
      ))
  )
    throw new Error(`Invalid selected pages: ${sample.id}`);
  const expected = sample.pages ? new Set(sample.pages).size : source;
  const flatPath = resolve(output, `${sample.id}.pdf`);
  const renderedPath = await access(flatPath).then(
    () => flatPath,
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return resolve(output, sample.id, `${sample.id}.pdf`);
    }
  );
  const actual = await pages(renderedPath);
  console.log(
    `${sample.id}: source ${expected}, rendered ${actual} ${actual === expected ? "PASS" : "FAIL"}`
  );
  if (actual !== expected) failed = true;
  const selection = sample.pages
    ? [...new Set(sample.pages)].sort((a, b) => a - b)
    : Array.from({ length: source }, (_, i) => i + 1);
  for (const check of await checkRenderedControls(
    sample.path,
    renderedPath,
    sample.controlChecks ?? [],
    selection,
    assets
  )) {
    console.log(
      `${sample.id}: checkbox "${check.text}" relative drift ${check.error.toFixed(2)} pt ${check.pass ? "PASS" : "FAIL"}`
    );
    if (!check.pass) failed = true;
  }
  for (const check of await checkRenderedBackgrounds(
    sample.path,
    renderedPath,
    sample.backgroundChecks ?? [],
    selection,
    assets
  )) {
    console.log(
      `${sample.id}: background "${check.text}" relative drift ${check.error.toFixed(2)} pt ${check.pass ? "PASS" : "FAIL"}`
    );
    if (!check.pass) failed = true;
  }
  // A text-presence gate cannot detect two title lines being reversed.
  for (const check of sample.renderOrderChecks ?? []) {
    if (
      !Number.isInteger(check.page) ||
      !selection.includes(check.page) ||
      !Array.isArray(check.texts) ||
      check.texts.length < 2 ||
      check.texts.length > 20 ||
      check.texts.some(
        (text) => typeof text !== "string" || !normalize(text)
      ) ||
      new Set(check.texts.map(normalize)).size !== check.texts.length
    )
      throw new Error(`Invalid render order check: ${sample.id}`);
    const sourceAnchors = await Promise.all(
      check.texts.map((text) => anchors(sample.path, check.page, text))
    );
    const ascending = (points) =>
      points.every(
        (p, i) =>
          p.length === 1 &&
          (!i || (points[i - 1].length === 1 && p[0].y > points[i - 1][0].y))
      );
    if (!ascending(sourceAnchors))
      throw new Error(`Source order missing or ambiguous: ${sample.id}`);
    const page = selection.indexOf(check.page) + 1;
    const renderedAnchors =
      page <= actual
        ? await Promise.all(
            check.texts.map((text) => anchors(renderedPath, page, text))
          )
        : [];
    const pass =
      renderedAnchors.length === check.texts.length &&
      ascending(renderedAnchors);
    console.log(`${sample.id}: title line order ${pass ? "PASS" : "FAIL"}`);
    if (!pass) failed = true;
  }
  for (const check of sample.renderChecks ?? []) {
    if (
      !Number.isInteger(check.page) ||
      check.page < 1 ||
      check.page > source ||
      typeof check.text !== "string" ||
      !normalize(check.text) ||
      !Number.isFinite(check.maxPositionError) ||
      check.maxPositionError < 0 ||
      (check.order !== undefined &&
        (check.occurrences === undefined ||
          !["left-to-right", "top-to-bottom"].includes(check.order))) ||
      (check.occurrences !== undefined &&
        (!Number.isInteger(check.occurrences) ||
          check.occurrences < 1 ||
          check.occurrences > 20))
    )
      throw new Error(`Invalid render check: ${sample.id}`);
    const renderedPage = selection.indexOf(check.page) + 1;
    if (!renderedPage || renderedPage > actual)
      throw new Error(`Render check page missing: ${sample.id}`);
    const [original, converted] = await Promise.all([
      anchors(sample.path, check.page, check.text),
      anchors(renderedPath, renderedPage, check.text),
    ]);
    // Fixtures name source text; do not accept a missing anchor as
    // success. The topmost matching run is deterministic for repeated prose.
    if (!original.length)
      throw new Error(`Source anchor missing: ${sample.id}: ${check.text}`);
    // A repeated opening in a newsletter must remain in every column. Match
    // those anchors left-to-right, since tiny baseline rounding differs by run.
    const count = check.occurrences ?? 1;
    if (check.occurrences !== undefined) {
      // Stacked tables need an explicit vertical order: tiny x differences
      // must not pair a heading in the upper table with the lower one.
      const compare =
        check.order === "top-to-bottom"
          ? (a, b) => a.y - b.y || a.x - b.x
          : (a, b) => a.x - b.x || a.y - b.y;
      original.sort(compare);
      converted.sort(compare);
      if (original.length !== count)
        throw new Error(
          `Source anchor count changed: ${sample.id}: ${check.text}`
        );
    }
    const drift =
      converted.length >= count &&
      (check.occurrences === undefined || converted.length === count)
        ? Math.max(
            ...original
              .slice(0, count)
              .flatMap((point, index) => [
                Math.abs(point.x - converted[index].x),
                Math.abs(point.y - converted[index].y),
              ])
          )
        : Infinity;
    const matches = drift <= check.maxPositionError;
    console.log(
      `${sample.id}: "${check.text}" drift ${drift.toFixed(2)} pt ${matches ? "PASS" : "FAIL"}`
    );
    if (!matches) failed = true;
  }
}
if (failed) process.exitCode = 1;
