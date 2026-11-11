import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
  server: {
    port: 5190,
    proxy: {
      // Personal tasks and Worker management share the built management listener.
      '/api/personal': {
        target: 'http://127.0.0.1:8860',
        changeOrigin: false,
      },
      '/api/manage': {
        target: 'http://127.0.0.1:8860',
        changeOrigin: false,
      },
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: false,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: { index: resolve('index.html'), worker: resolve('worker.html'), personal: resolve('personal.html') },
      output: {
        manualChunks: {
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
        },
      },
    },
  },
});
