import { defineConfig } from 'vite';

// Renderer-only build. The Electron main/preload are built by tsc.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome130'
  }
});
