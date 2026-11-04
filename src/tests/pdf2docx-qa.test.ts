import { expect, it } from "vitest";

import { decodeXmlText, docxEditableText } from "./helpers/pdf2docx-docx-text";

it("decodes XML text once, including punctuation and numeric references", () => {
  expect(
    decodeXmlText(
      "Employee&apos;s &quot;email&quot; &amp; &lt; &#62; &#x1F600; &amp;lt;"
    )
  ).toBe('Employee\'s "email" & < > 😀 &lt;');
});

const numbering = `<w:numbering><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num></w:numbering>`;
const paragraph = (id = "3") =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr></w:pPr><w:r><w:t>Employee&apos;s</w:t></w:r><m:r><m:t>1/2</m:t></m:r></w:p>`;
it("counts only used editable list labels with their start and continuation", () => {
  expect(
    docxEditableText(
      `<w:document>${paragraph()}${paragraph()}</w:document>`,
      numbering
    )
  ).toBe("3.Employee's1/24.Employee's1/2");
  expect(
    docxEditableText("<w:p><w:r><w:t>plain</w:t></w:r></w:p>", numbering)
  ).toBe("plain");
});
it("rejects missing or unsupported list definitions instead of guessing text", () => {
  expect(() => docxEditableText(paragraph("99"), numbering)).toThrow(
    "Missing numbering"
  );
  expect(() =>
    docxEditableText(
      paragraph(),
      numbering.replace('w:val="decimal"', 'w:val="lowerRoman"')
    )
  ).toThrow("Unsupported numbering");
});
