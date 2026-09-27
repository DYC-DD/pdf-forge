import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, isPreview, mode }) => {
  const pagesBasePath =
    loadEnv(mode, ".", "PAGES_").PAGES_BASE_PATH ?? "/pdf-forge";

  return {
    base: command === "build" || isPreview ? `${pagesBasePath}/` : "/",
    plugins: [react()],
  };
});
