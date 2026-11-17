import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 开发时前端在 5173,/api 代理到 Elysia(8080);生产构建输出到 web-dist,由 Elysia 直接托管。
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../web-dist', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8080' } },
})
