import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function getBase(env) {
  const prefix = env.S3GALLERY_APP_PREFIX || 'nexus/gallery';
  return `/${prefix.replace(/^\/+|\/+$/g, '')}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    base: getBase(env),
    build: {
      outDir: 'dist',
      // config.js lives in public/ and is copied as-is — never bundled
    },
  };
});
