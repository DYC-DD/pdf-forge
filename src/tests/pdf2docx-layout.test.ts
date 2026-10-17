import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  exportDocx,
  prepareExportPages,
} from "../features/pdf2docx/lib/exportDocx";
import { analyzeLayout } from "../features/pdf2docx/lib/layout";
import {
  buildLines,
  groupParagraphs,
  joinSeparator,
  paragraphText,
} from "../features/pdf2docx/lib/paragraphs";
import type {
  DocumentModel,
  FlowBlock,
  RawPage,
  Rule,
  TextSpan,
} from "../features/pdf2docx/types";

let nextId = 0;
function span(
  text: string,
  x: number,
  y: number,
  width = 200,
  extra: Partial<TextSpan> = {}
): TextSpan {
  return {
    id: String(nextId++),
    text,
    x,
    y,
    width,
    height: 12,
    baseline: y + 10,
    size: 12,
    font: "Helvetica",
    bold: false,
    italic: false,
    source: "pdf",
    ...extra,
  };
}
function page(spans: TextSpan[], rules: Rule[] = []): RawPage {
  return {
    number: 1,
    width: 600,
    height: 800,
    spans,
    rules,
    figures: [],
    issues: [],
    source: "pdf",
  };
}
function blocks(model: DocumentModel): FlowBlock[] {
  return model.pages.flatMap((entry) =>
    entry.groups.flatMap((group) => group.columns.flat())
  );
}
async function xml(
  model: DocumentModel,
  preservePageBreaks = false,
  qaName?: string
) {
  const blob = await exportDocx(model, { preservePageBreaks });
  if (qaName && process.env.PDF2DOCX_QA_DIR) {
    await mkdir(resolve(process.env.PDF2DOCX_QA_DIR), { recursive: true });
    await writeFile(
      resolve(process.env.PDF2DOCX_QA_DIR, `${qaName}.docx`),
      new Uint8Array(await blob.arrayBuffer())
    );
  }
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return {
    document: await zip.file("word/document.xml")!.async("string"),
    numbering: await zip.file("word/numbering.xml")!.async("string"),
  };
}

describe("PDF2docx paragraph reconstruction", () => {
  const region = { x: 50, y: 50, width: 500, height: 700 };
  it("joins wrapped lines into an editable paragraph and keeps inline styles", async () => {
    const spans = [
      span("This paragraph has", 50, 50, 110),
      span(" bold", 160, 50, 35, { bold: true }),
      span(" text", 195, 50, 28),
      span("and continues on the following line.", 50, 66, 220),
    ];
    const paragraphs = groupParagraphs(buildLines(spans), region, 12);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphText(paragraphs[0])).toBe(
      "This paragraph has bold text and continues on the following line."
    );
    expect(
      paragraphs[0].runs.some((run) => run.bold && run.text === " bold")
    ).toBe(true);
    const doc = await xml(analyzeLayout([page(spans)]));
    expect(doc.document).not.toContain("txbxContent");
    expect(doc.document).not.toContain("<w:br");
    expect(doc.document.match(/<w:p[ >]/g)).toHaveLength(1);
    expect(doc.document).toContain("<w:b/>");
  });
  it("keeps Chinese punctuation and joins Chinese wraps without inserting spaces", () => {
    const spans = [
      span("這是一份可編輯的", 50, 50),
      span("繁體中文文件。", 50, 66),
    ];
    expect(
      paragraphText(groupParagraphs(buildLines(spans), region, 12)[0])
    ).toBe("這是一份可編輯的繁體中文文件。");
    expect(joinSeparator("前一句。", "下一句")).toBe("");
  });
  it("separates paragraphs at spacing and first-line indentation", () => {
    const spans = [
      span("First line continues", 50, 50, 480),
      span("Second line continues", 50, 66, 480),
      span("Indented new paragraph", 74, 82, 400),
      span("with a wrapped line.", 50, 98, 180),
      span("A new spaced paragraph.", 50, 130, 250),
    ];
    const result = groupParagraphs(buildLines(spans), region, 12);
    expect(result.map(paragraphText)).toEqual([
      "First line continues Second line continues",
      "Indented new paragraph with a wrapped line.",
      "A new spaced paragraph.",
    ]);
    expect(result[1].firstIndent).toBe(24);
  });
  it("does not remove intentional repeated visible text", () => {
    const same = span("Repeated", 50, 50);
    const model = analyzeLayout([
      page([same, { ...same, id: "different-source" }]),
    ]);
    expect(model.stats.characters).toBe(16);
    expect(model.issues.some((issue) => issue.code === "coverage")).toBe(false);
    expect(
      blocks(model)
        .filter((block) => block.kind === "paragraph")
        .map(paragraphText)
        .join("")
    ).toContain("RepeatedRepeated");
  });
  it("exports Chinese text and actual Word numbering", async () => {
    const model = analyzeLayout([
      page([
        span("標題", 50, 50, 200, { size: 18, bold: true }),
        span("1. 第一個項目", 50, 100),
        span("2. 第二個項目", 50, 120),
        span("• 補充內容", 50, 150),
      ]),
    ]);
    const doc = await xml(model, false, "chinese");
    expect(doc.document).toContain("標題");
    expect(doc.document).toContain("第一個項目");
    expect(doc.document.match(/<w:numPr>/g)).toHaveLength(3);
    expect(doc.document).not.toContain(">1. 第一個項目<");
    expect(doc.numbering).toContain('w:val="decimal"');
    expect(doc.numbering).toContain('w:val="bullet"');
  });
});

describe("PDF2docx geometry and reading order", () => {
  it("keeps three prose columns in reading order with unequal gutters and spanning text", async () => {
    const spans = [
      span("Full width newsletter title", 50, 50, 450, { size: 22 }),
    ];
    for (let row = 0; row < 5; row++) {
      spans.push(span(`First column row ${row}`, 50, 110 + row * 15, 120));
      spans.push(span(`Second column row ${row}`, 195, 110 + row * 15, 130));
      spans.push(span(`Third column row ${row}`, 360, 110 + row * 15, 140));
    }
    spans.push(span("Full width closing paragraph", 50, 230, 450));
    const model = analyzeLayout([page(spans)]);
    expect(model.pages[0].groups.map((g) => g.columns.length)).toEqual([
      1, 3, 1,
    ]);
    const columns = model.pages[0].groups[1];
    expect(columns.gaps).toEqual([25, 35]);
    expect(columns.widths).toEqual([120, 130, 140]);
    for (const [i, label] of ["First", "Second", "Third"].entries()) {
      const text = columns.columns[i]
        .filter((b) => b.kind === "paragraph")
        .map(paragraphText)
        .join(" ");
      expect(text).toBe(
        Array.from(
          { length: 5 },
          (_, row) => `${label} column row ${row}`
        ).join(" ")
      );
    }
    expect(model.issues.filter((i) => i.code === "coverage")).toEqual([]);
    const doc = await xml(model, true);
    expect(doc.document).toContain('w:num="3"');
    expect(doc.document).toContain('w:space="500"');
    expect(doc.document).toContain('w:space="700"');
    expect(doc.document.indexOf("First column row 4")).toBeLessThan(
      doc.document.indexOf("Second column row 0")
    );
    expect(doc.document.indexOf("Second column row 4")).toBeLessThan(
      doc.document.indexOf("Third column row 0")
    );
  });
  it("keeps three short form fields on each row instead of inferring reading columns", () => {
    const spans = [0, 1, 2, 3].flatMap((row) =>
      [50, 200, 350].map((x, col) =>
        span(`Field ${row}-${col}`, x, 70 + row * 40, 80)
      )
    );
    const model = analyzeLayout([page(spans)]);
    expect(model.pages[0].groups.every((g) => g.columns.length === 1)).toBe(
      true
    );
  });
  it("separates narrow gutters before joining rows across two prose columns", () => {
    const spans = [
      span("Left heading", 50, 50, 244, { size: 24, bold: true }),
      span("Right opening", 299, 52, 210),
    ];
    for (let index = 0; index < 5; index++) {
      spans.push(span(`Left prose ${index}`, 50, 90 + index * 14, 246));
      spans.push(span(`Right prose ${index}`, 299, 90 + index * 14, 240));
    }
    const model = analyzeLayout([page(spans)]);
    expect(model.pages[0].groups).toHaveLength(1);
    const columns = model.pages[0].groups[0].columns;
    expect(columns).toHaveLength(2);
    const text = columns.map((column) =>
      column
        .filter((block) => block.kind === "paragraph")
        .map(paragraphText)
        .join(" ")
    );
    expect(text[0]).toContain("Left prose 4");
    expect(text[0]).not.toContain("Right");
    expect(text[1]).toContain("Right opening");
    expect(text[1]).not.toContain("Left");
    expect(model.issues.filter((issue) => issue.code === "coverage")).toEqual(
      []
    );
  });
  it("does not turn short paired form fields into narrow reading columns", () => {
    const spans: TextSpan[] = [];
    for (let index = 0; index < 5; index++) {
      spans.push(span(`Label ${index}`, 50, 70 + index * 20, 50));
      spans.push(span(`Value ${index}`, 104, 70 + index * 20, 55));
    }
    const model = analyzeLayout([page(spans)]);
    expect(
      model.pages[0].groups.every((group) => group.columns.length === 1)
    ).toBe(true);
  });
  it("ends a list at the body margin while keeping hanging continuation lines", () => {
    const model = analyzeLayout([
      page([
        span("• Wrapped item", 74, 80, 200),
        span("continued here", 92, 94, 160),
        span("Following body paragraph", 56, 114, 240),
        span("1. Numbered item", 74, 144, 200),
        span("Following explanation", 56, 164, 240),
      ]),
    ]);
    const paragraphs = blocks(model).filter(
      (block) => block.kind === "paragraph"
    );
    expect(paragraphs.map(paragraphText)).toEqual([
      "• Wrapped item continued here",
      "Following body paragraph",
      "1. Numbered item",
      "Following explanation",
    ]);
    expect(paragraphs.map((p) => p.role)).toEqual([
      "list",
      "body",
      "list",
      "body",
    ]);
  });
  it("reads down the left column before the right, including a spanning title", async () => {
    const spans = [
      span("Full width title", 50, 50, 500, { size: 20, bold: true }),
    ];
    for (let index = 0; index < 4; index++) {
      spans.push(span(`Left ${index}`, 50, 100 + index * 16, 190));
      spans.push(span(`Right ${index}`, 310, 100 + index * 16, 240));
    }
    const model = analyzeLayout([page(spans)]);
    const columns = model.pages[0].groups.find(
      (group) => group.columns.length === 2
    )!;
    expect(columns.widths).toEqual([190, 240]);
    expect(
      columns.columns[0]
        .filter((block) => block.kind === "paragraph")
        .map(paragraphText)
        .join(" ")
    ).toBe("Left 0 Left 1 Left 2 Left 3");
    const doc = await xml(model, false, "columns");
    expect(doc.document.indexOf("Left 3")).toBeLessThan(
      doc.document.indexOf("Right 0")
    );
    expect(doc.document).toContain('w:num="2"');
    // 14 pt of preset outer whitespace belongs to the outer columns; the
    // physical text widths remain 190/240 pt and the gutter remains 70 pt.
    expect(doc.document).toContain('w:w="4080"');
    expect(doc.document).toContain('w:w="5080"');
    expect(doc.document).toContain('w:type="column"');
  });
  it("keeps fill-in blanks inside single-column prose", () => {
    const model = analyzeLayout([
      page(
        [
          ...[50, 66, 82, 98].flatMap((y) => [
            span("A repeated form label", 50, y, 210),
            span("continued instruction", 290, y, 210),
          ]),
        ],
        [{ x1: 260, x2: 290, y1: 62, y2: 62 }]
      ),
    ]);
    expect(model.pages[0].groups).toHaveLength(1);
    expect(model.pages[0].groups[0].columns).toHaveLength(1);
  });

  it.each([-90, 90] as const)(
    "exports %s-degree table labels as editable rotated cells",
    async (rotation) => {
      const rules = [50, 150, 250]
        .map((x) => ({ x1: x, x2: x, y1: 50, y2: 250 }))
        .concat([50, 150, 250].map((y) => ({ x1: 50, x2: 250, y1: y, y2: y })));
      const model = analyzeLayout([
        page(
          [
            span("Rotated label", 80, 60, 12, { height: 80, rotation }),
            span("Normal", 160, 60, 60),
            span("Bottom", 60, 170, 60),
          ],
          rules
        ),
      ]);
      const table = blocks(model).find((b) => b.kind === "table")!;
      expect(table.cells[0].rotation).toBe(rotation);
      expect(table.cells[0].paragraphs[0].runs[0].width).toBeCloseTo(80);
      const result = await xml(model, true);
      expect(result.document).toContain(
        `w:textDirection w:val="${rotation === -90 ? "btLr" : "tbRl"}"`
      );
      expect(result.document).toContain("Rotated label");
    }
  );

  it("includes unruled outer columns when repeated row ends and text establish their edges", () => {
    const rules = [100, 200, 300]
      .map((x) => ({ x1: x, x2: x, y1: 50, y2: 110 }))
      .concat(
        [50, 70, 90, 110].map((y) => ({ x1: 50, x2: 350, y1: y, y2: y }))
      );
    const model = analyzeLayout([
      page(
        [55, 75, 95].flatMap((y) =>
          [55, 110, 210, 310].map((x, i) => span(String(i + 1), x, y, 15))
        ),
        rules
      ),
    ]);
    const table = blocks(model).find((b) => b.kind === "table")!;
    expect(table.columns).toHaveLength(4);
    expect(table.x).toBe(50);
    expect(table.width).toBe(300);
    expect(model.stats.paragraphs).toBe(0);
    expect(table.cells).toHaveLength(12);
  });

  it("reconstructs horizontal and vertical merged table cells without losing text", async () => {
    const rules: Rule[] = [
      { x1: 50, y1: 100, x2: 530, y2: 100 },
      { x1: 50, y1: 150, x2: 370, y2: 150 },
      { x1: 50, y1: 200, x2: 530, y2: 200 },
      { x1: 50, y1: 250, x2: 530, y2: 250 },
      { x1: 50, y1: 100, x2: 50, y2: 250 },
      { x1: 210, y1: 150, x2: 210, y2: 250 },
      { x1: 370, y1: 100, x2: 370, y2: 250 },
      { x1: 530, y1: 100, x2: 530, y2: 250 },
    ];
    const spans = [
      span("Merged header", 60, 115, 180),
      span("Tall cell", 380, 115, 100),
      span("A", 60, 165, 10),
      span("B", 220, 165, 10),
      span("C", 60, 215, 10),
      span("D", 220, 215, 10),
      span("E", 380, 215, 10),
    ];
    const model = analyzeLayout([page(spans, rules)]);
    const table = blocks(model).find((block) => block.kind === "table")!;
    expect(model.stats.tables).toBe(1);
    expect(table.cells).toHaveLength(7);
    expect(table.cells[0].columnSpan).toBe(2);
    expect(table.cells[1].rowSpan).toBe(2);
    expect(model.issues).not.toContainEqual(
      expect.objectContaining({ code: "coverage" })
    );
    const doc = await xml(model);
    expect(doc.document).toContain('<w:gridSpan w:val="2"/>');
    expect(doc.document).toContain('<w:vMerge w:val="restart"/>');
    expect(doc.document).toContain('<w:vMerge w:val="continue"/>');
    expect(doc.document.match(/<w:tr[ >]/g)).toHaveLength(3);
    expect(doc.document.match(/<w:tc[ >]/g)).toHaveLength(8);
    for (const entry of spans)
      expect(doc.document).toContain(`>${entry.text}<`);
  });
  it("writes landscape page dimensions without swapping width and height", async () => {
    const source = page([span("Landscape", 50, 50)]);
    source.width = 842;
    source.height = 595;
    const doc = await xml(analyzeLayout([source]));
    expect(doc.document).toContain(
      '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
    );
  });
  it("joins clear cross-page continuations only when page breaks are disabled", async () => {
    const one = page([span("A sentence continues", 50, 700, 500)]);
    const two = {
      ...page([span("onto the following page.", 50, 50, 500)]),
      number: 2,
    };
    const model = analyzeLayout([one, two]);
    const merged = prepareExportPages(model, { preservePageBreaks: false });
    const first = merged[0].groups[0].columns[0][0];
    expect(first.kind === "paragraph" && paragraphText(first)).toBe(
      "A sentence continues onto the following page."
    );
    expect(merged[1].groups[0].columns[0]).toHaveLength(0);
    expect(
      prepareExportPages(model, { preservePageBreaks: true })[1].groups[0]
        .columns[0]
    ).toHaveLength(1);
    expect(model.pages[1].groups[0].columns[0]).toHaveLength(1);
    expect((await xml(model, true)).document).toContain('w:val="nextPage"');
  });
  it("blocks output when source spans were not represented or no text exists", async () => {
    const broken = analyzeLayout([page([span("Missing", NaN, 50)])]);
    expect(broken.issues).toContainEqual(
      expect.objectContaining({ code: "coverage", severity: "error" })
    );
    await expect(
      exportDocx(broken, { preservePageBreaks: false })
    ).rejects.toThrow("完整讀取");
    await expect(
      exportDocx(analyzeLayout([page([])]), { preservePageBreaks: false })
    ).rejects.toThrow("沒有可輸出");
  });
});
