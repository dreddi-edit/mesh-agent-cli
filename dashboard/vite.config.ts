import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: dashboardRoot,
  plugins: [react()],
  build: {
    outDir: path.resolve(dashboardRoot, "../dist/dashboard"),
    emptyOutDir: true,
    sourcemap: false
  }
});
