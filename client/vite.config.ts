import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
  resolve: {
    // Allow importing the shared workspace as TS source directly.
    preserveSymlinks: false,
  },
});
