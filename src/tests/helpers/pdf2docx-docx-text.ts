// Read the XML emitted by our exporter, including editable automatic list
// labels. Decode entities once: literal "&amp;lt;" must stay "&lt;".
export function decodeXmlText(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    apos: "'",
    quot: '"',
  };
  return value.replace(
    /&(amp|lt|gt|apos|quot|#\d+|#x[\da-f]+);/giu,
    (_, entity: string) =>
      entity.startsWith("#")
        ? String.fromCodePoint(
            entity[1].toLowerCase() === "x"
              ? parseInt(entity.slice(2), 16)
              : Number(entity.slice(1))
          )
        : named[entity]
  );
}

export function docxEditableText(xml: string, numbering: string): string {
  const counters = new Map<string, number>();
  const value = (xml: string, tag: string) =>
    xml.match(new RegExp(`<w:${tag} w:val="([^"]*)"`))?.[1];
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)]
    .map(([paragraph]) => {
      let label = "";
      const num = paragraph.match(/<w:numPr>[\s\S]*?<\/w:numPr>/u)?.[0];
      if (num) {
        const id = value(num, "numId"),
          level = value(num, "ilvl");
        // Writer currently emits only single-level decimal/bullet lists. Fail
        // loudly if that contract changes instead of crediting guessed text.
        if (!id || level !== "0") throw new Error("Unsupported list level");
        const instance = [
          ...numbering.matchAll(/<w:num w:numId="(\d+)">([\s\S]*?)<\/w:num>/gu),
        ].find((m) => m[1] === id)?.[2];
        const abstractId = instance && value(instance, "abstractNumId");
        const abstract = [
          ...numbering.matchAll(
            /<w:abstractNum w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/gu
          ),
        ].find((m) => m[1] === abstractId)?.[2];
        const definition = abstract?.match(
          /<w:lvl w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/u
        )?.[1];
        if (!instance || !definition)
          throw new Error("Missing numbering definition");
        const format = value(definition, "numFmt");
        const template = value(definition, "lvlText");
        const start = Number(
          value(instance, "startOverride") ?? value(definition, "start") ?? 1
        );
        const current = counters.get(id) ?? start;
        if (
          !template ||
          !Number.isInteger(current) ||
          !["bullet", "decimal"].includes(format ?? "")
        )
          throw new Error("Unsupported numbering definition");
        label = decodeXmlText(template).replace(/%1/gu, String(current));
        if (/%[2-9]/u.test(label))
          throw new Error("Unsupported list placeholder");
        counters.set(id, current + 1);
      }
      const text = [
        ...paragraph.matchAll(/<(?:w|m):t(?:\s[^>]*)?>(.*?)<\/(?:w|m):t>/gs),
      ]
        .map((m) => decodeXmlText(m[1]))
        .join("");
      return label + text;
    })
    .join("");
}
