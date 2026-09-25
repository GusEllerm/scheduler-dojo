import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Level JSON + katas live at the repo root; the page fetches them under /levels/. */
const levelsDir = path.resolve(here, "../levels");

/** Dev-only: serve the repo `levels/` tree at `/levels/…` (builds would copy it separately). */
function serveLevels(): Plugin {
  return {
    name: "dojo:serve-levels",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (!url.startsWith("/levels/")) return next();
        const file = path.resolve(levelsDir, decodeURIComponent(url.slice("/levels/".length)));
        if (!file.startsWith(levelsDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
          return next();
        }
        res.setHeader("content-type", file.endsWith(".json") ? "application/json" : "text/plain");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // `public/` (with public/wheels/*.whl staged by scripts/build_wheel.sh AND public/levels copied by
  // scripts/copy-levels.mjs) is served at `/` in dev and copied verbatim into `dist/` on build.
  // base './' makes built asset URLs relative, so the site works under a GitHub-Pages subpath.
  base: "./",
  publicDir: "public",
  plugins: [serveLevels()],
  server: { host: "127.0.0.1", port: 5173 },
  build: { target: "es2022" },
});
