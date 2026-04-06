import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/nexus/gallery/',
  build: {
    outDir: 'dist',
    // config.js lives in public/ and is copied as-is — never bundled
  },
});
