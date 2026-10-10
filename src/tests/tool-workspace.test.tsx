import { createElement } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";

import ToolWorkspace from "../app/components/ToolWorkspace";
import type { Tool } from "../features/landing/ToolPicker";

const loads = vi.hoisted(() => ({
  merge: vi.fn(),
  split: vi.fn(),
  compress: vi.fn(),
  convert: vi.fn(),
}));

vi.mock("../features/merge/MergeWorkspace", () => {
  loads.merge();
  return { default: () => "merge workspace" };
});
vi.mock("../features/split/SplitWorkspace", () => {
  loads.split();
  return { default: () => "split workspace" };
});
vi.mock("../features/compress/CompressWorkspace", () => {
  loads.compress();
  return { default: () => "compress workspace" };
});
vi.mock("../features/convert/ConvertWorkspace", () => {
  loads.convert();
  return { default: () => "convert workspace" };
});

async function renderTool(tool: Tool) {
  const stream = await renderToReadableStream(
    createElement(ToolWorkspace, { tool })
  );
  await stream.allReady;
  return new Response(stream).text();
}

it("loads only the selected tool, shows a pending state and reuses loaded modules", async () => {
  const tools: Tool[] = ["merge", "split", "compress", "convert"];
  for (const tool of tools) expect(loads[tool]).not.toHaveBeenCalled();

  const pending = renderToString(
    createElement(ToolWorkspace, { tool: "merge" })
  );
  expect(pending.replaceAll("<!-- -->", "")).toContain("正在載入合併工具");
  expect(pending).toContain('role="status"');
  expect(pending).toContain('aria-busy="true"');

  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    expect(await renderTool(tool)).toContain(`${tool} workspace`);
    for (const [otherIndex, other] of tools.entries()) {
      expect(loads[other]).toHaveBeenCalledTimes(otherIndex <= index ? 1 : 0);
    }
  }

  for (const tool of [...tools].reverse()) {
    expect(await renderTool(tool)).toContain(`${tool} workspace`);
    expect(loads[tool]).toHaveBeenCalledOnce();
  }
});
