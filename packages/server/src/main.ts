/**
 * Server entrypoint: load the persisted world, start ticking, autosave.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GameServer } from "./server.js";
import { loadWorld, saveWorld } from "./persistence.js";

const PORT = Number(process.env.PORT ?? 8080);
const SAVE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../world.save.json");

const server = new GameServer({ port: PORT });

const loaded = await loadWorld(server.world, SAVE_PATH);
console.log(
  `World ${loaded ? "restored from save" : "freshly created"} — ` +
    `serving ws://localhost:${PORT} at ${1000 / 10}ms ticks`
);

// Seed a few colorful artifacts on first run so the world isn't empty.
if (!loaded) {
  const o = server.world.boardOrigin;
  server.world.addEntity("building", o.x - 10, o.y, "building", { skin: "castle" });
  server.world.addEntity("artifact", o.x + 9, o.y + 4, "artifact", { skin: "crystal" });
}

server.start();

const autosave = setInterval(() => void saveWorld(server.world, SAVE_PATH), 15_000);

async function shutdown(): Promise<void> {
  clearInterval(autosave);
  await saveWorld(server.world, SAVE_PATH);
  await server.stop();
  console.log("World saved. Bye.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
