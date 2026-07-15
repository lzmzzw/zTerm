// Author: Liz
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

function vendorChunk(moduleId: string) {
  const id = moduleId.replaceAll("\\", "/");
  if (!id.includes("/node_modules/")) return undefined;
  if (id.includes("/node_modules/lucide-react/")) return "icons";
  if (id.includes("/node_modules/@tauri-apps/")) return "tauri";
  if (id.includes("/node_modules/@xterm/") || id.includes("/node_modules/zmodem.js/")) return "terminal";
  if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return "react";
  return "vendor";
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
