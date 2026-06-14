import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    // Allow any host (e.g. *.trycloudflare.com tunnels) to reach the dev server.
    allowedHosts: true,
  },
  resolve: {
    // Allow importing the shared workspace as TS source directly.
    preserveSymlinks: false,
  },
});
