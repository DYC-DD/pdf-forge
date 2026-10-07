import JSZip from "jszip";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import { mergePdfs } from "../features/merge/lib/mergePdfs";
import { splitPdf } from "../features/split/lib/splitPdf";
import { copyPagesWithForms } from "../shared/pdf/copyPagesWithForms";

const name = PDFName.of;

async function asFile(document: PDFDocument, filename = "form.pdf") {
  return new File([new Uint8Array(await document.save())], filename, {
    type: "application/pdf",
  });
}

async function blankFile() {
  const document = await PDFDocument.create();
  document.addPage();
  return asFile(document, "blank.pdf");
}

function expectWidgetLinks(document: PDFDocument) {
  const pages = document.getPages();
  for (const field of document.getForm().getFields()) {
    for (const widget of field.acroField.getWidgets()) {
      const pageRef = widget.P();
      expect(pageRef).toBeInstanceOf(PDFRef);
      const page = pages.find((page) => page.ref === pageRef);
      expect(page).toBeDefined();
      expect(
        page!.node
          .Annots()!
          .asArray()
          .some((ref) => document.context.lookup(ref) === widget.dict)
      ).toBe(true);
    }
  }
  // Pruned widgets must not pull omitted pages into the serialized context.
  expect(
    document.context
      .enumerateIndirectObjects()
      .filter(([, object]) => object instanceof PDFPageLeaf)
  ).toHaveLength(pages.length);
}

describe("AcroForm field transplantation", () => {
  it("retains field types, values, flags and editable widgets when merging", async () => {
    const source = await PDFDocument.create();
    const first = source.addPage();
    const second = source.addPage();
    const form = source.getForm();
    const text = form.createTextField("profile.name");
    text.setText("Alice");
    text.setMaxLength(40);
    text.acroField.dict.set(name("DV"), PDFHexString.fromText("Default"));
    text.addToPage(first);
    const checkbox = form.createCheckBox("consent");
    checkbox.addToPage(first);
    checkbox.check();
    const radio = form.createRadioGroup("plan");
    radio.addOptionToPage("basic", first);
    radio.addOptionToPage("premium", second);
    radio.select("premium");
    const dropdown = form.createDropdown("country");
    dropdown.addOptions(["TW", "US"]);
    dropdown.select("TW");
    dropdown.addToPage(second);
    const list = form.createOptionList("tags");
    list.addOptions(["A", "B", "C"]);
    list.enableMultiselect();
    list.select(["B", "C"]);
    list.addToPage(second);
    const button = form.createButton("submit");
    button.addToPage("Send", first);
    button.acroField
      .getWidgets()[0]
      .dict.set(name("A"), source.context.obj({ S: "ResetForm" }));
    const readonly = form.createTextField("readonly");
    readonly.setText("Fixed");
    readonly.enableReadOnly();
    readonly.addToPage(second);

    const blob = await mergePdfs([await asFile(source), await blankFile()]);
    const result = await PDFDocument.load(await blob.arrayBuffer());
    const output = result.getForm();
    expect(output.getFields()).toHaveLength(7);
    expect(output.getTextField("profile.name").getText()).toBe("Alice");
    expect(output.getTextField("profile.name").getMaxLength()).toBe(40);
    expect(
      output
        .getTextField("profile.name")
        .acroField.dict.lookup(name("DV"), PDFHexString)
        .decodeText()
    ).toBe("Default");
    expect(output.getCheckBox("consent").isChecked()).toBe(true);
    expect(output.getRadioGroup("plan").getSelected()).toBe("premium");
    expect(output.getRadioGroup("plan").getOptions()).toEqual([
      "basic",
      "premium",
    ]);
    expect(output.getDropdown("country").getSelected()).toEqual(["TW"]);
    expect(output.getOptionList("tags").getSelected()).toEqual(["B", "C"]);
    expect(output.getButton("submit")).toBeDefined();
    expect(output.getTextField("readonly").isReadOnly()).toBe(true);
    expectWidgetLinks(result);

    // Verify that another PDF implementation sees registered form fields.
    const task = getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
    });
    try {
      const pdf = await task.promise;
      const fields = await pdf.getFieldObjects();
      expect(fields?.has("profile.name")).toBe(true);
      const annotations = await (await pdf.getPage(1)).getAnnotations();
      expect(
        annotations.find(
          (annotation) => annotation.fieldName === "profile.name"
        )?.fieldValue
      ).toBe("Alice");
      expect(
        annotations.filter((annotation) => annotation.subtype === "Widget")
      ).toHaveLength(4);
    } finally {
      await task.destroy();
    }

    output.getTextField("profile.name").setText("Bob");
    output.getCheckBox("consent").uncheck();
    output.getRadioGroup("plan").select("basic");
    const edited = (await PDFDocument.load(await result.save())).getForm();
    expect(edited.getTextField("profile.name").getText()).toBe("Bob");
    expect(edited.getCheckBox("consent").isChecked()).toBe(false);
    expect(edited.getRadioGroup("plan").getSelected()).toBe("basic");
  });

  it("renames colliding root namespaces without overwriting pre-numbered fields", async () => {
    async function make(values: Record<string, string>) {
      const doc = await PDFDocument.create();
      const page = doc.addPage();
      for (const [fieldName, value] of Object.entries(values)) {
        const field = doc.getForm().createTextField(fieldName);
        field.setText(value);
        field.addToPage(page);
      }
      return asFile(doc);
    }
    const blob = await mergePdfs([
      await make({ "person.name": "Alice" }),
      await make({ "person.name": "Bob", "person-2.name": "Carol" }),
    ]);
    const result = await PDFDocument.load(await blob.arrayBuffer());
    const form = result.getForm();
    expect(form.getFields().map((field) => field.getName())).toEqual([
      "person.name",
      "person-3.name",
      "person-2.name",
    ]);
    expect(form.getTextField("person.name").getText()).toBe("Alice");
    expect(form.getTextField("person-3.name").getText()).toBe("Bob");
    expect(form.getTextField("person-2.name").getText()).toBe("Carol");
    form.getTextField("person.name").setText("Changed");
    const saved = (await PDFDocument.load(await result.save())).getForm();
    expect(saved.getTextField("person-3.name").getText()).toBe("Bob");
    expectWidgetLinks(result);
  });

  it("prunes omitted widgets, fields and calculation entries for every split output", async () => {
    const source = await PDFDocument.create();
    const pages = [source.addPage(), source.addPage(), source.addPage()];
    const form = source.getForm();
    const shared = form.createTextField("customer.name");
    shared.setText("Alice");
    shared.addToPage(pages[0]);
    shared.addToPage(pages[2]);
    const omitted = form.createTextField("private");
    omitted.setText("Only on page two");
    omitted.addToPage(pages[1]);
    form.acroForm.dict.set(
      name("CO"),
      source.context.obj([shared.ref, omitted.ref])
    );
    const file = await asFile(source);
    const output = await splitPdf(file, [
      { id: "a", name: "selected", pages: [3, 1] },
      { id: "b", name: "single", pages: [2] },
    ]);
    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer());
    const selected = await PDFDocument.load(
      await zip.file("form-selected.pdf")!.async("uint8array")
    );
    expect(
      selected
        .getForm()
        .getFields()
        .map((field) => field.getName())
    ).toEqual(["customer.name"]);
    expect(
      selected.getForm().getTextField("customer.name").acroField.getWidgets()
    ).toHaveLength(2);
    expect(
      selected.catalog.AcroForm()!.lookup(name("CO"), PDFArray).asArray()
    ).toEqual([selected.getForm().getTextField("customer.name").ref]);
    expectWidgetLinks(selected);
    const single = await PDFDocument.load(
      await zip.file("form-single.pdf")!.async("uint8array")
    );
    expect(
      single
        .getForm()
        .getFields()
        .map((field) => field.getName())
    ).toEqual(["private"]);
    expectWidgetLinks(single);
    // The original source remains reusable across groups.
    expect(shared.acroField.getWidgets()).toHaveLength(2);
  });

  it.each([
    [1, "basic", undefined],
    [2, "premium", "premium"],
  ] as const)(
    "keeps radio export values and selection aligned after copying page %s",
    async (page, option, selection) => {
      const source = await PDFDocument.create();
      const first = source.addPage();
      const second = source.addPage();
      const radio = source.getForm().createRadioGroup("plan");
      radio.addOptionToPage("basic", first);
      radio.addOptionToPage("premium", second);
      radio.select("premium");
      const output = await splitPdf(await asFile(source), [
        { id: "a", name: "selected", pages: [page] },
      ]);
      const document = await PDFDocument.load(await output.blob.arrayBuffer());
      expect(document.getForm().getRadioGroup("plan").getOptions()).toEqual([
        option,
      ]);
      expect(document.getForm().getRadioGroup("plan").getSelected()).toBe(
        selection
      );
      expectWidgetLinks(document);
    }
  );

  it("keeps only the selected widget of a cross-page field and does not change the source", async () => {
    const source = await PDFDocument.create();
    const pages = [source.addPage(), source.addPage()];
    const field = source.getForm().createTextField("shared");
    field.setText("Alice");
    field.addToPage(pages[0]);
    field.addToPage(pages[1]);
    source.getForm().updateFieldAppearances();
    // Direct annotation dictionaries occur in some producer output.
    const widget = field.acroField.getWidgets()[1];
    pages[1].node.set(name("Annots"), source.context.obj([widget.dict]));
    const before = source.catalog.AcroForm()!.toString();
    for (const index of [1, 0]) {
      const target = await PDFDocument.create();
      await copyPagesWithForms(source, target, [index]);
      const result = await PDFDocument.load(
        await target.save({ updateFieldAppearances: false })
      );
      expect(
        result.getForm().getTextField("shared").acroField.getWidgets()
      ).toHaveLength(1);
      expectWidgetLinks(result);
    }
    expect(field.acroField.getWidgets()).toHaveLength(2);
    expect(source.catalog.AcroForm()!.toString()).toBe(before);
  });

  it("does not copy omitted pages through a form action's field references", async () => {
    const source = await PDFDocument.create();
    const first = source.addPage();
    const second = source.addPage();
    const form = source.getForm();
    const omitted = form.createTextField("private");
    omitted.setText("Secret");
    omitted.addToPage(second);
    const button = form.createButton("reset");
    button.addToPage("Reset", first);
    button.acroField
      .getWidgets()[0]
      .dict.set(
        name("A"),
        source.context.obj({ S: "ResetForm", Fields: [omitted.ref] })
      );
    const output = await splitPdf(await asFile(source), [
      { id: "a", name: "selected", pages: [1] },
    ]);
    const result = await PDFDocument.load(await output.blob.arrayBuffer());
    expect(
      result
        .getForm()
        .getFields()
        .map((field) => field.getName())
    ).toEqual(["reset"]);
    expectWidgetLinks(result);
    expect(
      result.context
        .enumerateIndirectObjects()
        .filter(
          ([, object]) =>
            object instanceof PDFDict && object.get(name("FT")) === name("Tx")
        )
    ).toHaveLength(0);
  });

  it.each(["F1", "Form Font"])(
    "preserves form-level defaults and colliding font resource %s",
    async (fontName) => {
      async function make(font: StandardFonts, value: string) {
        const doc = await PDFDocument.create();
        const page = doc.addPage();
        const embedded = await doc.embedFont(font);
        const form = doc.getForm();
        const field = form.createTextField(value);
        field.setText(value);
        field.addToPage(page, { font: embedded });
        form.updateFieldAppearances(embedded);
        field.acroField.dict.delete(name("DA"));
        form.acroForm.dict.set(
          name("DR"),
          doc.context.obj({ Font: { [fontName]: embedded.ref } })
        );
        form.acroForm.dict.set(
          name("DA"),
          PDFString.of(`${name(fontName).asString()} 12 Tf 0 g`)
        );
        form.acroForm.dict.set(name("Q"), PDFNumber.of(2));
        return asFile(doc);
      }
      const blob = await mergePdfs([
        await make(StandardFonts.Helvetica, "first"),
        await make(StandardFonts.Courier, "second"),
      ]);
      const result = await PDFDocument.load(await blob.arrayBuffer());
      const fonts = result.catalog
        .AcroForm()!
        .lookup(name("DR"), PDFDict)
        .lookup(name("Font"), PDFDict);
      expect(
        fonts
          .lookup(name(fontName), PDFDict)
          .lookup(name("BaseFont"), PDFName)
          .decodeText()
      ).toMatch(/^Helvetica/);
      expect(
        fonts
          .lookup(name(`${fontName}-2`), PDFDict)
          .lookup(name("BaseFont"), PDFName)
          .decodeText()
      ).toMatch(/^Courier/);
      expect(
        result.getForm().getTextField("second").acroField.getDefaultAppearance()
      ).toContain(`${name(`${fontName}-2`).asString()} 12 Tf`);
      expect(
        result
          .getForm()
          .getTextField("second")
          .acroField.dict.lookup(name("Q"), PDFNumber)
          .asNumber()
      ).toBe(2);
    }
  );

  it("retains combined field/widget dictionaries and inherited field attributes", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const form = source.getForm();
    const field = form.createTextField("group.name");
    field.setText("Alice");
    field.addToPage(page);
    form.updateFieldAppearances();
    const parent = field.acroField.getParent()!;
    parent.dict.set(name("FT"), name("Tx"));
    field.acroField.dict.delete(name("FT"));
    const widget = field.acroField.getWidgets()[0];
    for (const [key, value] of widget.dict.entries()) {
      if (key !== name("Parent")) field.acroField.dict.set(key, value);
    }
    field.acroField.dict.delete(name("Kids"));
    page.node.set(name("Annots"), source.context.obj([field.ref]));
    const target = await PDFDocument.create();
    await copyPagesWithForms(source, target, [0]);
    const result = await PDFDocument.load(
      await target.save({ updateFieldAppearances: false })
    );
    expect(result.getForm().getTextField("group.name").getText()).toBe("Alice");
    expectWidgetLinks(result);
    expect(field.acroField.dict.has(name("Kids"))).toBe(false);
  });

  it("keeps existing appearances and Unicode values without regenerating them", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const field = source.getForm().createTextField("姓名");
    field.setText("Alice");
    field.addToPage(page);
    source.getForm().updateFieldAppearances();
    field.acroField.dict.set(name("V"), PDFHexString.fromText("王小明"));
    source.catalog.AcroForm()!.set(name("NeedAppearances"), PDFBool.True);
    const file = new File(
      [new Uint8Array(await source.save({ updateFieldAppearances: false }))],
      "unicode.pdf"
    );
    const original = await PDFDocument.load(await file.arrayBuffer());
    const originalAppearance = original
      .getForm()
      .getTextField("姓名")
      .acroField.getWidgets()[0]
      .getAppearances()!.normal as PDFRawStream;
    const result = await PDFDocument.load(
      await (await mergePdfs([file, await blankFile()])).arrayBuffer()
    );
    const copied = result.getForm().getTextField("姓名");
    expect(copied.getText()).toBe("王小明");
    expect(
      (
        copied.acroField.getWidgets()[0].getAppearances()!
          .normal as PDFRawStream
      ).getContents()
    ).toEqual(originalAppearance.getContents());
    expect(
      result.catalog
        .AcroForm()!
        .lookup(name("NeedAppearances"), PDFBool)
        .asBoolean()
    ).toBe(true);
  });

  it("makes repeated page copies and their fields independent", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const field = source.getForm().createTextField("name");
    field.setText("Alice");
    field.addToPage(page);
    const output = await splitPdf(await asFile(source), [
      { id: "a", name: "repeat", pages: [1, 1] },
    ]);
    const result = await PDFDocument.load(await output.blob.arrayBuffer());
    expect(
      result
        .getForm()
        .getFields()
        .map((field) => field.getName())
    ).toEqual(["name", "name-2"]);
    expect(result.getPageCount()).toBe(2);
    expect(result.getPage(0).ref).not.toBe(result.getPage(1).ref);
    expectWidgetLinks(result);
  });

  it("rejects XFA instead of silently dropping unsupported form data", async () => {
    const source = await PDFDocument.create();
    source.addPage();
    source.catalog
      .getOrCreateAcroForm()
      .dict.set(
        name("XFA"),
        source.context.register(source.context.stream("<xfa/>"))
      );
    const file = new File(
      [new Uint8Array(await source.save({ updateFieldAppearances: false }))],
      "xfa.pdf"
    );
    await expect(mergePdfs([file, await blankFile()])).rejects.toThrow("XFA");
    await expect(
      splitPdf(file, [{ id: "a", name: "page", pages: [1] }])
    ).rejects.toThrow("XFA");
  });
});
