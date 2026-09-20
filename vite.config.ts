import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 桌面 renderer 只加载本地打包资源（tech-stack §3）：
// 相对 base 适配 file:// 加载；开发模式由 scripts/dev.mjs 提供 dev server。
export default defineConfig({
  root: 'src/ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist-ui',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
