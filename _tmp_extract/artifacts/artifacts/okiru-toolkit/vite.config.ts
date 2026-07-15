import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// Dev-only parity with production static hosting: serve public/<dir>/index.html
// for clean directory URLs like /toolkit/ or /bizbrain (prod does this natively).
function publicDirIndex(): Plugin {
  const publicDir = path.resolve(import.meta.dirname, "public");
  return {
    name: "public-dir-index",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const raw = req.url || "";
        const qIdx = raw.indexOf("?");
        const pathname = qIdx === -1 ? raw : raw.slice(0, qIdx);
        const query = qIdx === -1 ? "" : raw.slice(qIdx);
        if (pathname === "/" || pathname.includes("..") || /\.[a-zA-Z0-9]+$/.test(pathname)) {
          return next();
        }
        const clean = pathname.replace(/\/+$/, "");
        const candidate = path.join(publicDir, clean, "index.html");
        if (candidate.startsWith(publicDir + path.sep) && fs.existsSync(candidate)) {
          req.url = `${clean}/index.html${query}`;
        }
        next();
      });
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    publicDirIndex(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
