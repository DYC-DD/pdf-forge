import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages hosts this repository below /file-converter/.
  base: command === "build" || isPreview ? "/file-converter/" : "/",
  plugins: [react()],
}));
