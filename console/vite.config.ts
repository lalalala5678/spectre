import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    // 控制台 SPA 单 bundle 属预期形态——抬高告警限, 消部署噪声
    chunkSizeWarningLimit: 768,
  },
})
