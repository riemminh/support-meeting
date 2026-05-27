import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

function copyStaticExtensionFiles(): Plugin {
  return {
    name: "copy-static-extension-files",
    closeBundle() {
      const distDir = resolve(rootDir, "dist");
      mkdirSync(distDir, { recursive: true });
      copyFileSync(resolve(rootDir, "manifest.json"), resolve(distDir, "manifest.json"));
      copyFileSync(
        resolve(rootDir, "src", "overlay.css"),
        resolve(distDir, "overlay.css"),
      );
    },
  };
}

export default defineConfig({
  plugins: [copyStaticExtensionFiles()],
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        contentScript: resolve(rootDir, "src/contentScript.ts"),
        background: resolve(rootDir, "src/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
