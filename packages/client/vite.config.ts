import { defineConfig } from "vite";

export default defineConfig({
  // Pixi's async init uses top-level await; target modern browsers.
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: {
    port: 5173,
    host: true, // bind 0.0.0.0 so tunnels/LAN can reach the dev server
    allowedHosts: true, // accept any Host header (cloudflared, ngrok, LAN IPs)
    proxy: {
      // Forward the websocket to the game server during dev.
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
