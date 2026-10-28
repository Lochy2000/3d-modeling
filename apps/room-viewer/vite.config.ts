import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const app = import.meta.dirname;
const repository = resolve(app, '../..');

export default defineConfig(({ command }) => ({
  root: app,
  base: process.env.VIEWER_BASE || '/',
  optimizeDeps: { include: ['three/addons/objects/Reflector.js'] },
  // data/web-assets holds personal photos and scans: served by the dev server only, never copied into a build
  publicDir: command === 'serve' ? resolve(repository, 'data/web-assets') : false,
  server: {
    host: '127.0.0.1', port: 5188, strictPort: true, fs: { allow: [repository] },
    // Render evidence is output, not application source. Publishing a preview
    // image must not reload every viewer/capture in the middle of a build.
    watch: { ignored: ['**/data/captures/**', '**/data/recordings/**', '**/captures/**'] },
  },
  build: {
    outDir: resolve(app, 'dist'),
    rolldownOptions: {
      input: {
        main: resolve(app, 'index.html'),
        play: resolve(app, 'play.html'),
        capture: resolve(app, 'tools/capture.html'),
      },
    },
  },
}));
