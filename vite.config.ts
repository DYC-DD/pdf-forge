import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  // GitHub Pages hosts this repository below /file-converter/.
  base: command === 'build' ? '/file-converter/' : '/',
  plugins: [react()],
}))
