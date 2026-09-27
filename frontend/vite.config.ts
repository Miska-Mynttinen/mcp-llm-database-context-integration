import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API server (index.ts) listens on PORT, 3000 by default.
const apiTarget = process.env.API_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  build: {
    // Served by the API from dist/frontend (see staticDir in index.ts).
    outDir: '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': apiTarget,
    },
  },
})
