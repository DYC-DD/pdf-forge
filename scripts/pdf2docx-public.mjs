import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(
  root,
  process.env.PDF2DOCX_PUBLIC_DIR || ".cache/pdf2docx-public"
);
const samples = JSON.parse(
  await readFile(
    new URL("../src/tests/__fixtures__/pdf2docx-public.json", import.meta.url),
    "utf8"
  )
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mode = process.argv[2];
if (mode === "download") {
  await mkdir(directory, { recursive: true });
  for (const sample of samples) {
    const path = resolve(directory, `${sample.id}.pdf`);
    const cached = await readFile(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (cached) {
      if (digest(cached) !== sample.sha256)
        throw new Error(
          `${sample.id}: cached checksum mismatch; inspect the file before replacing it.`
        );
      console.log(`${sample.id}: verified cached PDF`);
      continue;
    }
    const response = await fetch(sample.url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`${sample.id}: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32 * 1024 * 1024)
          throw new Error(`${sample.id}: exceeds 32 MB`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    if (
      !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
      digest(bytes) !== sample.sha256
    )
      throw new Error(
        `${sample.id}: unexpected PDF or checksum; upstream may have changed. File not saved.`
      );
    await writeFile(path, bytes, { flag: "wx" });
    console.log(`${sample.id}: downloaded and verified`);
  }
} else if (mode === "test") {
  // Keep transform caches reachable when the Windows runner isolates TEMP.
  const temp = resolve(root, ".cache/test-temp");
  await mkdir(temp, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/tests/pdf2docx-public.test.ts",
      ...process.argv.slice(3),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        TEMP: temp,
        TMP: temp,
        PDF2DOCX_PUBLIC_DIR: directory,
      },
    }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  throw new Error(
    "Usage: node scripts/pdf2docx-public.mjs download|test [vitest options]"
  );
}
