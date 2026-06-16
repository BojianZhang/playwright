import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 后端 server.js 从 web/public 托管静态文件 → 产物输出到 ../public(相对 root=web 即 public)。
// publicDir:false —— 没有独立 static 目录,避免与 outDir(public)冲突。
// dev 模式 5173,把数据/任务/SSE/下载接口代理到后端 4317。
const BACKEND = process.env.OPENROUTER_WEB_DEV_BACKEND || 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  base: '/',
  publicDir: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../../../shared-web-ui'),
    },
  },
  build: {
    outDir: 'public',
    emptyOutDir: true, // 期1:旧 public 已移入 public-legacy 后才构建,此时 public 只放产物
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // 第三方库拆独立 chunk:vendor/query 单独缓存 → 改业务代码只失效 app chunk,第三方 chunk 浏览器继续命中
        //   缓存(重部署免重下);配合路由 lazy 进一步缩小首屏主包。
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  server: {
    fs: { allow: [path.resolve(__dirname, '../../..')] }, // dev server 可读 sibling 的 shared-web-ui
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/jobs': { target: BACKEND, changeOrigin: true },
      '/download': { target: BACKEND, changeOrigin: true },
      // SSE:Vite 代理默认透传长连接,不缓冲
      '/events': { target: BACKEND, changeOrigin: true },
    },
  },
});
