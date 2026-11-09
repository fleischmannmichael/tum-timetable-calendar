import { defineConfig } from 'vite';

// Builds the Apps Script engine (src/gas + src/core) into ONE plain script.
// The web app embeds this file into the personalised script it generates.
export default defineConfig({
  build: {
    outDir: 'dist-gas',
    emptyOutDir: true,
    minify: false,
    target: 'es2019',
    lib: {
      entry: 'src/gas/index.ts',
      name: 'TumCal',
      formats: ['iife'],
      fileName: () => 'tumcal-engine.js',
    },
  },
});
