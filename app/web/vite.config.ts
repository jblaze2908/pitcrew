import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into app/dist/web, which the control plane serves (and pre-compresses) at /.
// `npm run dev:web` proxies the API to a control plane on :8330.
const api = { target: "http://127.0.0.1:8330", changeOrigin: false };
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": api, "/files": api, "/shots": api, "/live": { ...api, ws: true }, "/novnc": api, "/code": { ...api, ws: true } } },
});
