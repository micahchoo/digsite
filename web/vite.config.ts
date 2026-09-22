import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// @digsite/shared's package.json "exports" map points every subpath at a
// .ts source file (there is no build step for it — see ../shared/package.json).
// Vite's resolver honours a plain-string exports map without extra config in
// most setups, but pin it with an alias anyway so a workspace-linking quirk
// in bun's node_modules layout can never silently fall back to a stale dist.
const sharedSrc = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true },
  resolve: {
    alias: [
      { find: '@digsite/shared', replacement: `${sharedSrc}/index.ts` },
      { find: /^@digsite\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` },
    ],
  },
});
