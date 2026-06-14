import { defineConfig, type Plugin } from "vite";
import { createReadStream, existsSync } from "fs";
import { resolve, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Serves ../shared/assets/ at /assets/ in the dev server. */
function sharedAssets(): Plugin {
  const dir = resolve(__dirname, "../shared/assets");
  const mime: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
  };
  return {
    name: "shared-assets",
    configureServer(server) {
      server.middlewares.use("/assets", (req, res, next) => {
        const url = req.url ?? "/";
        const filePath = resolve(dir, url.split("?")[0].replace(/^\//, ""));
        const m = mime[extname(filePath)];
        if (!m || !existsSync(filePath)) { next(); return; }
        res.setHeader("Content-Type", m);
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
  },
  resolve: {
    preserveSymlinks: false,
  },
  plugins: [sharedAssets()],
});
