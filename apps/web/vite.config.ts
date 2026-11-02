import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The API port is overridable so a throwaway instance can run alongside the one
 * you are developing against — otherwise testing a change means killing the dev
 * server, and killing it mid-round aborts a real interview and orphans its
 * recording. `API_PORT=8790 PORT=5174 pnpm dev` gives a second, isolated stack.
 */
const API_PORT = process.env.API_PORT ?? '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    allowedHosts: true,
    port: Number(process.env.PORT ?? 5173),
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${API_PORT}`, ws: true },
    },
  },
});
