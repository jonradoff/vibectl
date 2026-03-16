import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4370,
    proxy: {
      '/api': {
        target: 'http://localhost:4380',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:4380',
        changeOrigin: true,
      },
      '/docs': {
        target: 'http://localhost:4380',
        changeOrigin: true,
      },
      '/skill.md': {
        target: 'http://localhost:4380',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:4380',
        ws: true,
      },
    },
  },
})
