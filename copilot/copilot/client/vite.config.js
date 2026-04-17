import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Project root (parent of /client) — same folder as `.env` */
const rootDir = path.resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const apiPort = env.PORT || "3001";

  return {
    root: __dirname,
    plugins: [react()],
    build: {
      outDir: path.resolve(__dirname, "../dist/client"),
      emptyOutDir: true,
    },
    server: {
      port: Number(env.VITE_PORT) || 5173,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
        "/auth": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
