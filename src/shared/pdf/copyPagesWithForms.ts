import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectCopier,
  PDFPage,
  PDFString,
  type PDFDocument,
  type PDFObject,
  type PDFPageLeaf,
  type PDFRef,
} from "pdf-lib";

const name = PDFName.of;

function dictionary(value: PDFObject | undefined, context: PDFContext) {
  const object = context.lookup(value);
  return object instanceof PDFDict ? object : undefined;
}

function text(value: PDFObject | undefined) {
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

function uniqueName(original: string, reserved: Set<string>) {
  let candidate = original;
  let suffix = 2;
  while (reserved.has(candidate)) candidate = `${original}-${suffix++}`;
  reserved.add(candidate);
  return candidate;
}

function mergeResources(
  source: PDFDict,
  target: PDFDict,
  copier: PDFObjectCopier
) {
  const sourceResources = source.lookupMaybe(name("DR"), PDFDict);
  const renamed = new Map<string, PDFName>();
  if (!sourceResources) return renamed;

  const targetResources =
    target.lookupMaybe(name("DR"), PDFDict) ?? target.context.obj({});
  target.set(name("DR"), targetResources);
  const resourceNames = (resources: PDFDict) =>
    resources.values().flatMap((value) => {
      const category = dictionary(value, resources.context);
      return category ? category.keys() : [];
    });
  const existing = new Set(
    resourceNames(targetResources).map((key) => key.decodeText())
  );
  const incoming = resourceNames(sourceResources);
  const reserved = new Set([
    ...existing,
    ...incoming.map((key) => key.decodeText()),
  ]);
  for (const resource of incoming) {
    if (
      existing.has(resource.decodeText()) &&
      !renamed.has(resource.asString())
    ) {
      renamed.set(
        resource.asString(),
        name(uniqueName(resource.decodeText(), reserved))
      );
    }
  }

  for (const [categoryName, value] of sourceResources.entries()) {
    const category = dictionary(value, source.context);
    if (!category) {
      if (!targetResources.has(categoryName)) {
        targetResources.set(categoryName, copier.copy(value));
      }
      continue;
    }
    const targetCategory =
      targetResources.lookupMaybe(categoryName, PDFDict) ??
      target.context.obj({});
    targetResources.set(categoryName, targetCategory);
    for (const [key, resource] of category.entries()) {
      const replacement = renamed.get(key.asString());
      targetCategory.set(replacement ?? key, copier.copy(resource));
    }
  }
  return renamed;
}

/** Copy pages and their AcroForm graph together, without changing the source. */
export async function copyPagesWithForms(
  source: PDFDocument,
  target: PDFDocument,
  indices: number[]
): Promise<void> {
  const sourceForm = source.catalog.AcroForm();
  if (sourceForm?.has(name("XFA"))) {
    throw new Error("這份 PDF 使用 XFA 表單，目前無法保留其欄位並合併或拆分。");
  }
  if (!sourceForm?.lookupMaybe(name("Fields"), PDFArray)?.size()) {
    const pages = await target.copyPages(source, indices);
    for (const page of pages) target.addPage(page);
    return;
  }

  // Separate repeated pages into independent imports so each occurrence gets
  // its own page, widgets and (collision-safe) fields.
  if (new Set(indices).size !== indices.length) {
    let batch: number[] = [];
    for (const index of indices) {
      if (batch.includes(index)) {
        await copyPagesWithForms(source, target, batch);
        batch = [];
      }
      batch.push(index);
    }
    if (batch.length) await copyPagesWithForms(source, target, batch);
    return;
  }

  await source.flush();
  const pages = source.getPages();
  const selected = indices.map((index) => pages[index]);
  const widgetPages = new Map<PDFDict, PDFRef>();
  for (const page of selected) {
    for (const annotation of page.node.Annots()?.asArray() ?? []) {
      const widget = dictionary(annotation, source.context);
      if (widget?.get(name("Subtype")) === name("Widget")) {
        widgetPages.set(widget, page.ref);
      }
    }
  }

  // A shallow context projects only the field tree. Streams and page contents
  // stay shared until the copier moves them to the output document.
  const projected = PDFContext.create();
  const originalRefs = new Map<PDFObject, PDFRef>();
  for (const [ref, object] of source.context.enumerateIndirectObjects()) {
    projected.assign(ref, object);
    originalRefs.set(object, ref);
  }
  const clones = new Map<PDFDict, { dict: PDFDict; ref: PDFRef }>();
  const retained = new Set<PDFDict>();
  function clone(original: PDFDict) {
    const cached = clones.get(original);
    if (cached) return cached;
    const dict = original.clone(projected);
    const ref = originalRefs.get(original) ?? projected.nextRef();
    projected.assign(ref, dict);
    const result = { dict, ref };
    clones.set(original, result);
    return result;
  }

  function retainField(value: PDFObject): PDFRef | undefined {
    const original = dictionary(value, source.context);
    if (!original) return;
    if (retained.has(original))
      throw new Error("PDF 表單欄位結構包含重複或循環參照。");
    retained.add(original);
    const { dict, ref } = clone(original);
    const originalKids = original.lookupMaybe(name("Kids"), PDFArray);
    const keptIndices: number[] = [];
    const kids: PDFRef[] = [];
    for (const [index, kid] of (originalKids?.asArray() ?? []).entries()) {
      const kept = retainField(kid);
      if (kept) {
        kids.push(kept);
        keptIndices.push(index);
        projected.lookup(kept, PDFDict).set(name("Parent"), ref);
      }
    }
    const isWidget = original.get(name("Subtype")) === name("Widget");
    const hiddenField = !isWidget && !originalKids?.size();
    if (
      !widgetPages.has(original) &&
      kids.length === 0 &&
      !(hiddenField && selected.length === pages.length)
    ) {
      retained.delete(original);
      // Actions may still reference an omitted field. Never follow that
      // reference back through its widgets to an unselected page.
      projected.assign(ref, PDFNull);
      return;
    }
    if (originalKids) dict.set(name("Kids"), projected.obj(kids));
    if (isWidget) {
      const pageRef = widgetPages.get(original);
      if (!pageRef) {
        retained.delete(original);
        projected.assign(ref, PDFNull);
        return;
      }
      dict.set(name("P"), pageRef);
    }
    const options = original.lookupMaybe(name("Opt"), PDFArray);
    // Button export values correspond to widget order, unlike choice options.
    if (originalKids) {
      let field: PDFDict | undefined = original;
      const ancestors = new Set<PDFDict>();
      while (field && !field.has(name("FT"))) {
        if (ancestors.has(field))
          throw new Error("PDF 表單欄位的父層參照包含循環。");
        ancestors.add(field);
        field = dictionary(field.get(name("Parent")), source.context);
      }
      if (field?.lookup(name("FT")) === name("Btn")) {
        if (options?.size() === originalKids.size()) {
          dict.set(
            name("Opt"),
            projected.obj(keptIndices.map((i) => options.get(i)))
          );
        }
        const hasState = (widget: PDFObject, state: PDFName) => {
          const annotation = dictionary(widget, source.context);
          const normal = annotation
            ?.lookupMaybe(name("AP"), PDFDict)
            ?.lookup(name("N"));
          return normal instanceof PDFDict && normal.has(state);
        };
        for (const key of ["V", "DV"]) {
          const value = original.lookup(name(key));
          if (
            value instanceof PDFName &&
            value !== name("Off") &&
            originalKids.asArray().some((kid) => hasState(kid, value)) &&
            !keptIndices.some((index) =>
              hasState(originalKids.get(index), value)
            )
          ) {
            // A radio option on an omitted page must not remain selected.
            dict.set(name(key), name("Off"));
          }
        }
      }
    }
    return ref;
  }

  const roots = sourceForm.lookup(name("Fields"), PDFArray).asArray();
  const importedRoots = roots.flatMap((root) => {
    const ref = retainField(root);
    return ref ? [ref] : [];
  });
  // Resolve page annotations through the projected widgets, including merged
  // field/widget dictionaries and direct (rather than indirect) annotations.
  for (const page of selected) {
    const { dict } = clone(page.node);
    const annotations = page.node.Annots();
    if (annotations) {
      dict.set(
        name("Annots"),
        projected.obj(
          annotations.asArray().map((annotation) => {
            const original = dictionary(annotation, source.context);
            return (original && clones.get(original)?.ref) ?? annotation;
          })
        )
      );
    }
  }

  const copier = PDFObjectCopier.for(projected, target.context);
  if (importedRoots.length) {
    const targetForm = target.catalog.getOrCreateAcroForm();
    const renamedResources = mergeResources(
      sourceForm,
      targetForm.dict,
      copier
    );
    const fieldName = (field: PDFDict) =>
      text(field.lookup(name("T"))) ?? "field";
    const existingNames = new Set(
      targetForm.getFields().map(([field]) => fieldName(field.dict))
    );
    const incomingNames = importedRoots.map((ref) =>
      fieldName(projected.lookup(ref, PDFDict))
    );
    const reserved = new Set([...existingNames, ...incomingNames]);
    for (const ref of importedRoots) {
      const root = projected.lookup(ref, PDFDict);
      const originalName = fieldName(root);
      if (existingNames.has(originalName)) {
        root.set(
          name("T"),
          PDFHexString.fromText(uniqueName(originalName, reserved))
        );
      }
      existingNames.add(fieldName(root));
      for (const key of ["DA", "Q"]) {
        const defaultValue = sourceForm.get(name(key));
        if (!root.has(name(key)) && defaultValue)
          root.set(name(key), defaultValue);
      }
      root.delete(name("Parent"));
    }
    for (const original of retained) {
      const { dict } = clone(original);
      const appearance = text(dict.lookup(name("DA")));
      if (appearance && renamedResources.size) {
        dict.set(
          name("DA"),
          PDFString.of(
            appearance.replace(
              /\/[^\s\[\]()<>/%]+/g,
              (token) => renamedResources.get(token)?.asString() ?? token
            )
          )
        );
      }
    }
    for (const ref of importedRoots) targetForm.addField(copier.copy(ref));
    if (sourceForm.lookupMaybe(name("NeedAppearances"), PDFBool)?.asBoolean()) {
      targetForm.dict.set(name("NeedAppearances"), PDFBool.True);
    }
    const signatureFlags =
      sourceForm.lookupMaybe(name("SigFlags"), PDFNumber)?.asNumber() ?? 0;
    if (signatureFlags) {
      const existingFlags =
        targetForm.dict.lookupMaybe(name("SigFlags"), PDFNumber)?.asNumber() ??
        0;
      targetForm.dict.set(
        name("SigFlags"),
        PDFNumber.of(existingFlags | signatureFlags)
      );
    }
    const order = sourceForm.lookupMaybe(name("CO"), PDFArray);
    if (order) {
      const targetOrder =
        targetForm.dict.lookupMaybe(name("CO"), PDFArray) ??
        target.context.obj([]);
      for (const entry of order.asArray()) {
        const original = dictionary(entry, source.context);
        if (original && retained.has(original))
          targetOrder.push(copier.copy(clone(original).ref));
      }
      targetForm.dict.set(name("CO"), targetOrder);
    }
  }
  for (const page of selected) {
    const ref = copier.copy(page.ref);
    const node = target.context.lookup(ref) as PDFPageLeaf;
    // The copier recognizes PDFPageLeaf and preserves inherited page resources.
    target.addPage(PDFPage.of(node, ref, target));
  }
}
