import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Run after rendering each exported DOCX to <output>/<id>/<id>.pdf. This
// deliberately checks the rendered result, not DOCX section counts.
const manifest =
  process.env.PDF2DOCX_CORPUS_MANIFEST ?? process.env.PDF2DOCX_PRIVATE_MANIFEST;
const output = process.env.PDF2DOCX_QA_DIR;
if (!manifest || !output)
  throw new Error(
    "Set PDF2DOCX_CORPUS_MANIFEST (or PDF2DOCX_PRIVATE_MANIFEST) and PDF2DOCX_QA_DIR first."
  );
const samples = JSON.parse(await readFile(resolve(manifest), "utf8"));
if (!Array.isArray(samples) || !samples.length)
  throw new Error("The manifest must contain at least one PDF sample.");

async function pages(path) {
  const task = getDocument({ data: new Uint8Array(await readFile(path)) });
  try {
    return (await task.promise).numPages;
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
  const actual = await pages(resolve(output, sample.id, `${sample.id}.pdf`));
  console.log(
    `${sample.id}: source ${expected}, rendered ${actual} ${actual === expected ? "PASS" : "FAIL"}`
  );
  if (actual !== expected) failed = true;
}
if (failed) process.exitCode = 1;
