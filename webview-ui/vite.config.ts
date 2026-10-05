import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// base: './' + unhashed, fixed filenames -- this bundle is ultimately
// loaded inside a VS Code WebviewPanel via `webview.asWebviewUri()`
// rewritten relative paths, not served from a normal site root. Output
// goes straight into the extension host's own dist/ so a single
// `vsce package` picks up both.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
