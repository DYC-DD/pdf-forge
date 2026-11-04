import JSZip from "jszip";
import { expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import type { RawPage, TextSpan } from "../features/pdf2docx/types";

const model = (
  markers: string[],
  colors: (string | undefined)[],
  source: "pdf" | "ocr" = "pdf"
) => {
  const spans: TextSpan[] = markers.flatMap((text, i) => {
    const base = {
      y: 80 + i * 30,
      height: 12,
      baseline: 92 + i * 30,
      size: 12,
      font: "Helvetica",
      bold: false,
      italic: false,
      source,
    };
    return [
      { ...base, id: `marker-${i}`, text, x: 50, width: 10, color: colors[i] },
      {
        ...base,
        id: `body-${i}`,
        text: `Entry ${i + 1}`,
        x: 74,
        width: 80,
        color: "000000",
      },
    ];
  });
  const page: RawPage = {
    number: 1,
    width: 400,
    height: 400,
    spans,
    rules: [],
    figures: [],
    issues: [],
    source,
  };
  return analyzeLayout([page]);
};
async function inspect(
  input: ReturnType<typeof model>,
  preservePageBreaks = true
) {
  const zip = await JSZip.loadAsync(
    await (await exportDocx(input, { preservePageBreaks })).arrayBuffer()
  );
  const xml = await zip.file("word/numbering.xml")!.async("string");
  return {
    xml,
    document: await zip.file("word/document.xml")!.async("string"),
    definitions: [
      ...xml.matchAll(/<w:abstractNum\b.*?<\/w:abstractNum>/gu),
    ].map((m) => m[0]),
  };
}
it.each([true, false])(
  "keeps native marker color in source/reflow export %s",
  async (preserve) => {
    const input = model(["•"], ["0070C0"]),
      before = structuredClone(input),
      result = await inspect(input, preserve);
    expect(
      result.definitions.some(
        (d) =>
          d.includes('w:val="bullet"') && d.includes('w:color w:val="0070C0"')
      )
    ).toBe(true);
    expect(result.document).toContain('w:color w:val="000000"');
    expect(result.document).not.toContain("<w:drawing");
    expect(input).toEqual(before);
  }
);
it("does not reuse a preceding marker color and keeps decimal starts across color changes", async () => {
  const result = await inspect(
    model(["1.", "2.", "3."], ["0070C0", "FF0000", "000000"])
  );
  for (const [color, start] of [
    ["0070C0", 1],
    ["FF0000", 2],
    ["000000", 3],
  ] as const)
    expect(
      result.definitions.some(
        (d) =>
          d.includes(`w:color w:val="${color}"`) &&
          d.includes(`w:start w:val="${start}"`)
      )
    ).toBe(true);
  expect((result.document.match(/<w:numPr>/gu) ?? []).length).toBe(3);
});
it("reuses a same-color list and retains unknown-color defaults", async () => {
  const result = await inspect(
    model(["•", "•", "•"], ["0070C0", "0070C0", undefined])
  );
  const ids = [...result.document.matchAll(/<w:numId w:val="(\d+)"/gu)].map(
    (m) => m[1]
  );
  expect(ids).toHaveLength(3);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[2]).not.toBe(ids[1]);
});
it("does not infer native marker styling from OCR color", async () => {
  const result = await inspect(model(["•"], ["0070C0"], "ocr"));
  expect(result.xml).not.toContain('w:color w:val="0070C0"');
});
