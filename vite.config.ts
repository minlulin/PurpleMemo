import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: "vendor-markdown",
              test: /[\\/]node_modules[\\/](react-markdown|remark-|micromark|mdast-|unist-|vfile|hast-|devlop|property-information|space-separated-tokens|comma-separated-tokens|estree-util-|html-url-attributes|trim-lines|trough|bail|is-plain-obj)/,
            },
            {
              name: "vendor-crypto-zip",
              test: /[\\/]node_modules[\\/](@noble|fflate)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
