import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The report viewer (src/report/viewer/main.tsx) as ONE self-contained
// script with its CSS inlined: a report file carries it in a <script>, so
// it can load nothing else. Written into public/, so the app serves it at
// /report-viewer.js and the main build copies it into dist/. Generated;
// ignored by git.
const sharedSrc = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    alias: [
      { find: /^@digsite\/shared$/, replacement: `${sharedSrc}/index.ts` },
      { find: /^@digsite\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` },
    ],
  },
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: false,
    lib: {
      entry: 'src/report/viewer/main.tsx',
      formats: ['iife'],
      name: 'digsiteReportViewer',
      fileName: () => 'report-viewer.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
