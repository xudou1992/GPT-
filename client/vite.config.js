import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientDir,
  build: {
    outDir: path.resolve(clientDir, '..', 'public'),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(clientDir, 'index.html'),
      output: {
        entryFileNames: 'assets/app-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/generated': 'http://localhost:3000'
    }
  }
});
