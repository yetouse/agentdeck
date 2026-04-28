import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/health': 'http://127.0.0.1:4000',
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
})
