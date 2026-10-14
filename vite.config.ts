import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

async function copyAsset(
  source: string,
  destination: string,
  staging: string
): Promise<void> {
  if ((await stat(source)).isDirectory()) {
    await mkdir(destination, { recursive: true });
    await Promise.all(
      (await readdir(source)).map((entry) =>
        copyAsset(resolve(source, entry), resolve(destination, entry), staging)
      )
    );
    return;
  }
  // Dev, test and build can run together. Publish complete files atomically;
  // removing a shared resource directory can break another running process.
  await mkdir(staging, { recursive: true });
  const temporary = resolve(staging, randomUUID());
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assetsCurrent(
  destination: string,
  version: string
): Promise<boolean> {
  return (
    (await readFile(resolve(destination, ".assets-version"), "utf8").catch(
      () => ""
    )) === version
  );
}

function pdfjsAssets(): Plugin {
  const packageDirectory = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json")
  );

  return {
    name: "pdfjs-assets",
    async configResolved({ publicDir, cacheDir }) {
      // Generated assets stay in sync with the installed PDF.js version.
      const destination = resolve(publicDir, "pdfjs");
      const version = JSON.parse(
        await readFile(resolve(packageDirectory, "package.json"), "utf8")
      ).version as string;
      if (await assetsCurrent(destination, version)) return;
      await mkdir(destination, { recursive: true });
      await Promise.all(
        ["cmaps", "standard_fonts", "wasm", "iccs"].map((directory) =>
          copyAsset(
            resolve(packageDirectory, directory),
            resolve(destination, directory),
            resolve(cacheDir, "static-assets")
          )
        )
      );
      await writeFile(resolve(destination, ".assets-version"), version);
    },
  };
}

function ocrAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const directory = (name: string) =>
    dirname(require.resolve(`${name}/package.json`));
  return {
    name: "local-ocr-assets",
    async configResolved({ publicDir, cacheDir }) {
      const destination = resolve(publicDir, "ocr");
      const versions = await Promise.all(
        [
          "tesseract.js",
          "tesseract.js-core",
          "@tesseract.js-data/eng",
          "@tesseract.js-data/chi_tra",
        ].map(
          async (name) =>
            JSON.parse(
              await readFile(resolve(directory(name), "package.json"), "utf8")
            ).version as string
        )
      );
      const version = `ocr-assets-v1:${versions.join(":")}`;
      if (await assetsCurrent(destination, version)) return;
      const cp = (source: string, target: string) =>
        copyAsset(source, target, resolve(cacheDir, "static-assets"));
      await mkdir(resolve(destination, "core"), { recursive: true });
      await mkdir(resolve(destination, "lang"), { recursive: true });
      await cp(
        resolve(directory("tesseract.js"), "dist/worker.min.js"),
        resolve(destination, "worker.min.js")
      );
      // OEM.LSTM_ONLY selects one of these three browser-compatible builds.
      await Promise.all(
        ["lstm", "simd-lstm", "relaxedsimd-lstm"].flatMap((variant) =>
          ["wasm.js", "wasm"].map((extension) =>
            cp(
              resolve(
                directory("tesseract.js-core"),
                `tesseract-core-${variant}.${extension}`
              ),
              resolve(
                destination,
                "core",
                `tesseract-core-${variant}.${extension}`
              )
            )
          )
        )
      );
      await Promise.all(
        ["eng", "chi_tra"].map((language) =>
          cp(
            resolve(
              directory(`@tesseract.js-data/${language}`),
              `4.0.0_best_int/${language}.traineddata.gz`
            ),
            resolve(destination, "lang", `${language}.traineddata.gz`)
          )
        )
      );
      await cp(
        resolve(directory("tesseract.js-core"), "LICENSE"),
        resolve(destination, "LICENSE-tesseract-core")
      );
      await cp(
        resolve(directory("tesseract.js"), "LICENSE.md"),
        resolve(destination, "LICENSE-tesseract-js.md")
      );
      await cp(
        resolve(dirname(require.resolve("docx")), "../LICENSE"),
        resolve(destination, "LICENSE-docx")
      );
      await cp(
        resolve(directory("tesseract.js-core"), "LICENSE"),
        resolve(destination, "LICENSE-tessdata")
      );
      await writeFile(
        resolve(destination, "NOTICE.txt"),
        [
          "PDF2docx browser dependencies",
          "",
          "docx: https://github.com/dolanmiu/docx (MIT, see LICENSE-docx)",
          "Tesseract.js: https://github.com/naptha/tesseract.js (Apache-2.0, see LICENSE-tesseract-js.md)",
          "Tesseract.js-core: https://github.com/naptha/tesseract.js-core (Apache-2.0, see LICENSE-tesseract-core)",
          "eng and chi_tra traineddata: https://github.com/naptha/tessdata/tree/gh-pages/4.0.0_best_int",
          "Model license: https://github.com/naptha/tessdata/blob/gh-pages/LICENSE (Apache-2.0, see LICENSE-tessdata)",
          "Distributed through @tesseract.js-data/eng and @tesseract.js-data/chi_tra, version 1.0.0.",
          "",
        ].join("\n")
      );
      await writeFile(resolve(destination, ".assets-version"), version);
    },
  };
}

export default defineConfig(({ command, isPreview, mode }) => {
  const pagesBasePath =
    loadEnv(mode, ".", "PAGES_").PAGES_BASE_PATH ?? "/pdf-forge";

  return {
    base: command === "build" || isPreview ? `${pagesBasePath}/` : "/",
    plugins: [react(), pdfjsAssets(), ocrAssets()],
    optimizeDeps: { exclude: ["@jsquash/jpeg", "@jsquash/webp"] },
  };
});
