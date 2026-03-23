import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Allow port overrides for client mode (port 4375 → backend 4385)
// vs. standalone dev mode (port 4370 → backend 4380).
const devPort = parseInt(process.env.VITE_PORT ?? '4370', 10)
const backendPort = process.env.VITE_BACKEND_PORT ?? '4380'
const backendURL = `http://localhost:${backendPort}`
const wsURL = `ws://localhost:${backendPort}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: devPort,
    proxy: {
      '/api': {
        target: backendURL,
        changeOrigin: true,
      },
      '/uploads': {
        target: backendURL,
        changeOrigin: true,
      },
      '/docs': {
        target: backendURL,
        changeOrigin: true,
      },
      '/skill.md': {
        target: backendURL,
        changeOrigin: true,
      },
      '/ws': {
        target: wsURL,
        ws: true,
      },
    },
  },
})
