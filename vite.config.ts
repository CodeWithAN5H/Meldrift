import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const src = fileURLToPath(new URL('./src', import.meta.url));
const shared = fileURLToPath(new URL('./shared', import.meta.url));

// Tauri expects a fixed dev port and must not watch Rust sources.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': src, '@shared': shared },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome110',
    sourcemap: false,
    minify: 'esbuild',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
