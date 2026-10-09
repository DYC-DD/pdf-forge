import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

function pdfjsAssets(): Plugin {
  const packageDirectory = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json")
  );

  return {
    name: "pdfjs-assets",
    async configResolved({ publicDir }) {
      // Generated assets stay in sync with the installed PDF.js version.
      const destination = resolve(publicDir, "pdfjs");
      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await Promise.all(
        ["cmaps", "standard_fonts", "wasm", "iccs"].map((directory) =>
          cp(
            resolve(packageDirectory, directory),
            resolve(destination, directory),
            {
              recursive: true,
            }
          )
        )
      );
    },
  };
}

export default defineConfig(({ command, isPreview, mode }) => {
  const pagesBasePath =
    loadEnv(mode, ".", "PAGES_").PAGES_BASE_PATH ?? "/pdf-forge";

  return {
    base: command === "build" || isPreview ? `${pagesBasePath}/` : "/",
    plugins: [react(), pdfjsAssets()],
    optimizeDeps: { exclude: ["@jsquash/jpeg", "@jsquash/webp"] },
  };
});
