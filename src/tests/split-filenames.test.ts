import { describe, expect, it } from "vitest";

import { resolveGroupFilenames } from "../features/split/lib/resolveGroupFilenames";
import type { PageGroup } from "../features/split/types";

function group(id: string, filename?: string): PageGroup {
  return { id, name: `部分 ${id}`, filename, pages: [1] };
}

describe("split output filenames", () => {
  it("numbers duplicate names from 1 and keeps the output order", () => {
    const groups = ["1", "2", "3", "4"].map((id) => group(id, "報告"));
    const resolved = resolveGroupFilenames("source.pdf", groups);

    expect(resolved.map((entry) => entry.filename)).toEqual([
      "報告",
      "報告-1",
      "報告-2",
      "報告-3",
    ]);
    expect(resolved.map((entry) => entry.id)).toEqual(["1", "2", "3", "4"]);
    expect(groups.map((entry) => entry.filename)).toEqual(
      Array(4).fill("報告")
    );
  });

  it("renames the edited field and skips numbers already used by other fields", () => {
    const resolved = resolveGroupFilenames(
      "source.pdf",
      [group("1", "report"), group("2", "REPORT"), group("3", "report-1")],
      "1"
    );

    expect(resolved.map((entry) => entry.filename)).toEqual([
      "report-2",
      "REPORT",
      "report-1",
    ]);
  });

  it.each([
    ["Report", " report.PDF  ", "report-1"],
    ["報告_附件", "報告/附件", "報告_附件-1"],
    ["source-部分 2", "   ", "source-部分 2-1"],
  ])(
    "detects collisions after normalizing %s and %s",
    (existing, input, expected) => {
      const resolved = resolveGroupFilenames(
        "source.pdf",
        [group("1", existing), group("2", input)],
        "2"
      );

      expect(resolved[1].filename).toBe(expected);
    }
  );

  it("restores the default name when a custom name is cleared", () => {
    expect(
      resolveGroupFilenames("source.pdf", [group("1", "")], "1")[0].filename
    ).toBe("source-部分 1");
  });

  it("resolves repeated default group names after removing and adding a group", () => {
    const resolved = resolveGroupFilenames("source.pdf", [
      group("2"),
      { ...group("3"), name: "部分 2" },
    ]);

    expect(resolved.map((entry) => entry.filename)).toEqual([
      "source-部分 2",
      "source-部分 2-1",
    ]);
  });

  it("keeps resolved filenames stable on blur, export, and removal", () => {
    const resolved = resolveGroupFilenames("source.pdf", [
      group("1", "報告"),
      group("2", "報告"),
      group("3", "報告"),
    ]);

    expect(resolveGroupFilenames("source.pdf", resolved, "1")).toEqual(
      resolved
    );
    expect(resolveGroupFilenames("source.pdf", resolved)).toEqual(resolved);
    expect(resolveGroupFilenames("source.pdf", resolved.slice(1))).toEqual(
      resolved.slice(1)
    );
  });
});
