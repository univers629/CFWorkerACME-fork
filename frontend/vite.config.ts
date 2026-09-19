import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 后端 API 路径列表（与 src/index.ts 中 Hono 路由对齐）
// 注意：前端使用 HashRouter，SPA 路由形如 /#/admin/users，
//       不会与下面的 /admin 真实后端路径冲突，可以安全地整段代理。
const API_PATHS = [
  '/bootstrap',
  '/login',
  '/setup',
  '/nonce',
  '/check',
  '/exits',
  '/apply',
  '/order',
  '/acmes',
  '/token',
  '/erase',
  '/certs',
  '/panel',
  '/users',
  '/tests',
  '/tasks',
  '/clean',
  // 管理员后台（/admin/users、/admin/certs、/admin/confs …）
  '/admin',
  // 开放 API（/api/v1/*）
  '/api',
  // 账号 API Token（/account/apitoken、/account/apitoken/rotate）
  '/account',
  // 证书打包下载
  '/ca_zip',
  '/ca_pfx',
];

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@api': path.resolve(__dirname, 'src/api'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@layouts': path.resolve(__dirname, 'src/layouts'),
      '@pages': path.resolve(__dirname, 'src/pages'),
      '@stores': path.resolve(__dirname, 'src/stores'),
      '@theme': path.resolve(__dirname, 'src/theme'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },

  css: {
    postcss: './postcss.config.js',
  },

  build: {
    outDir: '../public',
    // public/ 是纯构建产物目录（index.html / assets / favicon.svg），每次构建先清空，
    // 避免历史版本的带哈希文件名堆在里面被一起上传到 Cloudflare。
    emptyOutDir: true,
    assetsDir: 'assets',
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-antd': ['antd', '@ant-design/icons'],
          'vendor-charts': ['@ant-design/charts'],
          'vendor-utils': ['axios', 'zustand', 'crypto-js', 'framer-motion', 'dayjs'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },

  server: {
    port: 5173,
    host: '127.0.0.1',
    open: false,
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [
        p,
        {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
          secure: false,
        },
      ]),
    ),
  },

  preview: {
    port: 4173,
    host: '127.0.0.1',
  },
});
