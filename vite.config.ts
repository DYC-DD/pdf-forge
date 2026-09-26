import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // GitHub Pages hosts this repository below /file-converter/.
  base: command === "build" ? "/file-converter/" : "/",
  plugins: [react()],
}));
