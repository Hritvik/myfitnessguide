import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * In production the Worker serves this app and /tools on one origin behind
 * Cloudflare Access, so the app holds no credentials. In development Vite
 * proxies /tools to `wrangler dev --local` (port 8787), which signs every
 * localhost request in as LOCAL_DEV_IDENTITY from app/worker/.dev.vars.
 */
const WORKER = process.env.GYM_WORKER_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.GYM_APP_VERSION ?? (() => {
      try {
        return execSync("git rev-parse --short HEAD").toString().trim();
      } catch {
        return "dev";
      }
    })()),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/tools": { target: WORKER, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { "/tools": { target: WORKER, changeOrigin: true } },
  },
  build: { target: "es2022", sourcemap: true },
});
