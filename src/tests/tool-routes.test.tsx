import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { toolFromPath, toolHref } from "../app/toolRoutes";
import ToolPicker, { type Tool } from "../features/landing/ToolPicker";

beforeEach(() => {
  vi.stubEnv("BASE_URL", "/pdf-forge/");
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: true }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("offers four tools with conversion as the fourth mode", () => {
  const markup = renderToStaticMarkup(
    createElement(ToolPicker, {
      tool: "convert",
      onSelect: vi.fn(),
      hrefForTool: toolHref,
    })
  );
  expect(
    [...markup.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1])
  ).toEqual(["merge-panel", "split-panel", "compress-panel", "convert-panel"]);
  expect(markup).toContain(
    'href="/pdf-forge/convert/" class="tool-tab active"'
  );
  expect(markup).not.toContain("pdf2docx");
});

it("resolves the four tool routes and preserves former Word links", () => {
  const tools: Tool[] = ["merge", "split", "compress", "convert"];
  for (const tool of tools) {
    expect(toolFromPath(toolHref(tool))).toBe(tool);
    expect(toolFromPath(toolHref(tool).slice(0, -1))).toBe(tool);
  }
  expect(toolFromPath("/pdf-forge/pdf2docx/")).toBe("convert");
  expect(toolFromPath("/pdf-forge/pdf2docx")).toBe("convert");
  expect(toolFromPath("/pdf-forge/unknown/")).toBeNull();
  expect(toolFromPath("/other/pdf2docx/")).toBeNull();
});
