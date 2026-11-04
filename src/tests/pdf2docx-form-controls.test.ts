import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { exportDocx } from "../features/pdf2docx/lib/exportDocx";
import { anchorFormControls } from "../features/pdf2docx/lib/formControls";
import { anchorTextBackgrounds } from "../features/pdf2docx/lib/textBackgrounds";
import type {
  DocumentModel,
  ImageBlock,
  PageModel,
  Paragraph,
  TableModel,
} from "../features/pdf2docx/types";

const label = (extra: Partial<Paragraph> = {}): Paragraph => ({
  kind: "paragraph",
  role: "body",
  x: 100,
  y: 100,
  width: 200,
  height: 10,
  source: "pdf",
  runs: [
    {
      text: "Choice label",
      size: 10,
      font: "Helvetica",
      bold: false,
      italic: false,
    },
  ],
  ids: ["label"],
  align: "left",
  before: 20,
  lineHeight: 12,
  indent: 0,
  firstIndent: 0,
  lastLineWidth: 200,
  ...extra,
});
const control = (extra: Partial<ImageBlock> = {}): ImageBlock => ({
  kind: "image",
  id: "control",
  before: 0,
  x: 88,
  y: 100,
  width: 8,
  height: 8,
  data: Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII="
    ),
    (c) => c.charCodeAt(0)
  ),
  overlay: true,
  formControl: true,
  ...extra,
});
const page = (paragraphs = [label()], overlays = [control()]): PageModel => ({
  number: 1,
  width: 612,
  height: 792,
  margins: { top: 40, bottom: 40, left: 40, right: 40 },
  groups: [{ columns: [paragraphs], gap: 0 }],
  source: "pdf",
  characters: 12,
  overlays,
});

describe("form controls follow their editable labels", () => {
  it("attaches a background by all source IDs, never by nearby text alone", () => {
    for (const ids of [["label"], ["missing"], ["label", "missing"]]) {
      const p = label();
      const image = control({
        formControl: false,
        textBackgroundFor: ids,
        behindText: true,
      });
      const model = page([p], [image]);
      anchorTextBackgrounds(model);
      anchorTextBackgrounds(model);
      expect(p.backgroundImages?.length ?? 0).toBe(
        ids.length === 1 && ids[0] === "label" ? 1 : 0
      );
      expect(
        (p.backgroundImages?.length ?? 0) + (model.overlays?.length ?? 0)
      ).toBe(1);
    }
    for (const paragraphs of [[label(), label()], [label({ source: "ocr" })]]) {
      const model = page(paragraphs, [
        control({ textBackgroundFor: ["label"] }),
      ]);
      anchorTextBackgrounds(model);
      expect(model.overlays).toHaveLength(1);
    }
    const model = page(
      [label()],
      [control({ textBackgroundFor: ["label"], inFooter: true })]
    );
    anchorTextBackgrounds(model);
    expect(model.overlays).toHaveLength(1);
  });

  it("attaches multiple controls once, preserving their relative positions", () => {
    const p = label({ height: 24 });
    const images = [control(), control({ id: "second", y: 112 })];
    const model = page([p], images);
    anchorFormControls(model);
    anchorFormControls(model);
    expect(model.overlays).toEqual([]);
    expect(p.controlImages).toEqual(images);
    expect(p.controlImages?.map((i) => i.y - p.y)).toEqual([0, 12]);
  });
  it("retains page anchors when the label is absent or ambiguous", () => {
    for (const paragraphs of [
      [],
      [label(), label({ x: 95 })],
      [label({ y: 200 })],
    ]) {
      const model = page(paragraphs);
      anchorFormControls(model);
      expect(model.overlays).toHaveLength(1);
      expect(paragraphs.every((p) => !p.controlImages)).toBe(true);
    }
  });
  it("does not reclassify artwork, footer graphics, large widgets or OCR labels", () => {
    for (const image of [
      control({ formControl: false }),
      control({ inFooter: true }),
      control({ width: 30 }),
      control({ height: 30 }),
    ]) {
      const model = page([label()], [image]);
      anchorFormControls(model);
      expect(model.overlays).toEqual([image]);
    }
    const model = page([label({ source: "ocr" })]);
    anchorFormControls(model);
    expect(model.overlays).toHaveLength(1);
  });
  it("anchors cell controls only when no body paragraph competes", () => {
    for (const body of [[], [label()]]) {
      const hasBody = body.length > 0;
      const model = page(body);
      model.groups[0].columns[0].push({
        kind: "table",
        x: 80,
        y: 90,
        width: 300,
        height: 40,
        before: 0,
        columns: [300],
        rows: [40],
        cells: [
          {
            row: 0,
            column: 0,
            rowSpan: 1,
            columnSpan: 1,
            paragraphs: [label()],
          },
        ],
      });
      anchorFormControls(model);
      expect(model.overlays).toHaveLength(hasBody ? 1 : 0);
    }
  });

  it.each([-90, 90] as const)(
    "retains controls in rotated cells (%s degrees)",
    (rotation) => {
      const model = page([]);
      model.groups[0].columns[0].push({
        kind: "table",
        x: 80,
        y: 90,
        width: 300,
        height: 40,
        before: 0,
        columns: [300],
        rows: [40],
        cells: [
          {
            row: 0,
            column: 0,
            rowSpan: 1,
            columnSpan: 1,
            rotation,
            paragraphs: [label()],
          },
        ],
      });
      anchorFormControls(model);
      expect(model.overlays).toHaveLength(1);
    }
  );
  it("ignores neighboring cells that cannot contain the widget", () => {
    const owner = label({ x: 120, width: 65 });
    const neighbor = label({ x: 198, width: 120 });
    const model = page([], [control({ x: 180 })]);
    model.groups[0].columns[0].push({
      kind: "table",
      x: 80,
      y: 90,
      width: 260,
      height: 40,
      before: 0,
      columns: [110, 150],
      rows: [40],
      cells: [
        { row: 0, column: 0, rowSpan: 1, columnSpan: 1, paragraphs: [owner] },
        {
          row: 0,
          column: 1,
          rowSpan: 1,
          columnSpan: 1,
          paragraphs: [neighbor],
        },
      ],
    });
    anchorFormControls(model);
    expect(model.overlays).toHaveLength(0);
    expect(owner.controlImages).toHaveLength(1);
    expect(neighbor.controlImages).toBeUndefined();
  });
  it("does not pull a widget across a cell border toward nearby text", () => {
    const model = page([], [control({ x: 73 })]);
    model.groups[0].columns[0].push({
      kind: "table",
      x: 80,
      y: 90,
      width: 300,
      height: 40,
      before: 0,
      columns: [300],
      rows: [40],
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          columnSpan: 1,
          paragraphs: [label({ x: 85 })],
        },
      ],
    });
    anchorFormControls(model);
    expect(model.overlays).toHaveLength(1);
  });
  it("exports cell-relative offsets with padding and merged rows/columns, without paragraph space-before", async () => {
    const p = page([], [control({ x: 128, y: 120 })]);
    const table: TableModel = {
      kind: "table",
      x: 80,
      y: 90,
      width: 220,
      height: 60,
      before: 0,
      columns: [40, 90, 90],
      rows: [20, 20, 20],
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          columnSpan: 3,
          paragraphs: [
            label({ x: 85, y: 90, height: 10, width: 150, before: 0 }),
          ],
        },
        { row: 1, column: 0, rowSpan: 2, columnSpan: 1, paragraphs: [] },
        {
          row: 1,
          column: 1,
          rowSpan: 2,
          columnSpan: 2,
          padding: { left: 3, right: 3 },
          paragraphs: [
            label({
              x: 140,
              y: 120,
              width: 120,
              before: 20,
              indent: 17,
              runs: [
                {
                  text: "Cell choice",
                  size: 10,
                  font: "Helvetica",
                  bold: false,
                  italic: false,
                },
              ],
            }),
          ],
        },
      ],
    };
    p.groups[0].columns[0].push(table);
    const model: DocumentModel = {
      pages: [p],
      issues: [],
      stats: {
        pages: 1,
        characters: 20,
        paragraphs: 2,
        tables: 1,
        images: 1,
        ocrPages: 0,
      },
    };
    const before = structuredClone(model);
    const zip = await JSZip.loadAsync(
      await (
        await exportDocx(model, { preservePageBreaks: true })
      ).arrayBuffer()
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    const paragraph = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map((m) => m[0])
      .find((p) => p.includes("Cell choice"))!;
    expect(paragraph).toContain(
      '<wp:positionH relativeFrom="column"><wp:posOffset>63500</wp:posOffset>'
    );
    expect(paragraph).toContain(
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset>'
    );
    expect(paragraph).toContain('layoutInCell="1"');
    expect(paragraph).toContain("<wp:wrapNone/>");
    expect(xml.match(/<wp:anchor /g)).toHaveLength(1);
    expect(model).toEqual(before);
  });

  it.each([true, false])(
    "exports a paragraph-relative anchor without mutating the model (page breaks %s)",
    async (preservePageBreaks) => {
      const model: DocumentModel = {
        pages: [page()],
        issues: [],
        stats: {
          pages: 1,
          characters: 12,
          paragraphs: 1,
          tables: 0,
          images: 1,
          ocrPages: 0,
        },
      };
      const before = structuredClone(model);
      const zip = await JSZip.loadAsync(
        await (await exportDocx(model, { preservePageBreaks })).arrayBuffer()
      );
      const xml = await zip.file("word/document.xml")!.async("string");
      const p = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
        .map((m) => m[0])
        .find((p) => p.includes("Choice label"))!;
      expect(p).toContain('<wp:positionV relativeFrom="paragraph">');
      expect(p).toContain('<wp:positionH relativeFrom="page">');
      expect(p).toContain("<wp:wrapNone/>");
      expect(xml.match(/<wp:anchor /g)).toHaveLength(1);
      expect(model).toEqual(before);
    }
  );
});
