import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist");

await Promise.all(
  ["merge", "split", "compress", "convert", "pdf2docx"].map(async (tool) => {
    const directory = resolve(output, tool);
    await mkdir(directory, { recursive: true });
    await copyFile(
      resolve(output, "index.html"),
      resolve(directory, "index.html")
    );
  })
);
