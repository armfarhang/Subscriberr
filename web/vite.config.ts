import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 127.0.0.1, not localhost: the server listens on IPv4 and localhost may resolve to ::1 first.
const API = 'http://127.0.0.1:3000';

// Dev: Vite on :5173 proxies the API to the server on :3000. Prod: the server serves web/dist.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/api': API, '/auth': API, '/healthz': API },
  },
  build: { outDir: 'dist', sourcemap: false },
});
