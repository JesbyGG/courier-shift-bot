import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mini App может раздаваться как с корня домена, так и из подпапки —
// относительный base делает сборку переносимой.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
