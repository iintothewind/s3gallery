import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Use a relative base so built asset references work when the SPA is
  // deployed under any S3 prefix (e.g. "gallery/"), not just a hard-coded one.
  base: './',
  build: {
    outDir: 'dist',
    // config.js lives in public/ and is copied as-is — never bundled
  },
});