import { describe, expect, it } from "vitest";

import { markSearchableScanDisagreements } from "../features/pdf2docx/lib/searchableScan";
import type { TextSpan } from "../features/pdf2docx/types";

const span = (text: string, y = 50): TextSpan => ({
  id: text,
  text,
  x: 50,
  y,
  width: 180,
  height: 12,
  baseline: y + 10,
  size: 12,
  font: "Arial",
  source: "ocr",
  confidence: 99,
  bold: false,
  italic: false,
});
describe("searchable scan text agreement", () => {
  it("preserves a row when even high-confidence OCR changes a fraction", () => {
    const result = [span("Ye pound imported cheese")];
    markSearchableScanDisagreements(result, [span("⅛ pound imported cheese")]);
    expect(result[0].sourceMismatch).toBe(true);
    expect(result[0].text).toBe("Ye pound imported cheese");
    expect(result[0].confidence).toBe(99);
  });
  it("accepts equivalent whitespace and Unicode forms without altering text", () => {
    const result = [span("1/2 pound cheese")];
    markSearchableScanDisagreements(result, [span("１/２ pound  cheese")]);
    expect(result[0].sourceMismatch).toBeUndefined();
  });
  it("does not compare text from an unrelated source row", () => {
    const result = [span("A visible caption", 100)];
    markSearchableScanDisagreements(result, [span("Another row", 50)]);
    expect(result[0].sourceMismatch).toBeUndefined();
  });
});
