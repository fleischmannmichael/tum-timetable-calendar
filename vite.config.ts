/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Web configurator. `base: './'` makes the build work on any GitHub Pages path.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
