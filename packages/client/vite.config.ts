import { defineConfig } from "vite";

export default defineConfig({
  // Pixi's async init uses top-level await; target modern browsers.
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: {
    port: 5173,
    proxy: {
      // Forward the websocket to the game server during dev.
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
