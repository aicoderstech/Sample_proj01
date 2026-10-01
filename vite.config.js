import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { createImageProxy } from './server/imageProxy.mjs';

// Serves /api/image-proxy from the Vite dev and preview servers too, so
// `npm run dev` behaves like `npm start`.
function imageProxyPlugin() {
  const handler = createImageProxy();
  const mount = (server) => {
    server.middlewares.use('/api/image-proxy', handler);
  };
  return { name: 'mirrorfit-image-proxy', configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig({
  // Relative asset URLs so the site also works from a sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [imageProxyPlugin()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        studio: resolve(import.meta.dirname, 'studio.html'),
        store: resolve(import.meta.dirname, 'demo-store.html'),
        notFound: resolve(import.meta.dirname, '404.html'),
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
});
