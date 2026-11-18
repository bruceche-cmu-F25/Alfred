import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const home = `http://127.0.0.1:${process.env.ALFRED_PORT ?? 7480}`;
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The main interface, and the Mac app's always-on-top figure.
    rollupOptions: { input: { main: page("index.html"), presence: page("presence.html") } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The home node accepts only its own Host and Origin; present the proxy as same-origin.
      "/api": {
        target: home,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (request) => request.removeHeader("origin")),
      },
    },
  },
});
