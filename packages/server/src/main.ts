/**
 * Server entrypoint: start the open-plane chess server.
 *
 * Persistence is minimal: only id counters are saved across restarts. Armies
 * are tied to live connections and recreated on join, so a clean restart wipes
 * the field (which is the right behavior for short play sessions).
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GameServer } from "./server.js";
import { loadWorld, saveWorld } from "./persistence.js";
import { loadStats, saveStats } from "./stats.js";
import { loadLedger, saveLedger } from "./ledger.js";

const PORT = Number(process.env.PORT ?? 8080);
const SAVE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../world.save.json");
const STATS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../stats.json");
const LEDGER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../ledger.json");

const server = new GameServer({ port: PORT, statsPath: STATS_PATH, ledgerPath: LEDGER_PATH });

const loaded = await loadWorld(server.world, SAVE_PATH);
const statsLoaded = await loadStats(server.stats, STATS_PATH);
await loadLedger(server.ledger, LEDGER_PATH);
console.log(statsLoaded ? "Stats restored" : "Stats fresh");
console.log(
  `World ${loaded ? "restored from save" : "freshly created"} — ` +
    `serving ws://localhost:${PORT} at ${1000 / 10}ms ticks`
);

server.start();

const autosave = setInterval(() => void saveWorld(server.world, SAVE_PATH), 15_000);

async function shutdown(): Promise<void> {
  clearInterval(autosave);
  await saveWorld(server.world, SAVE_PATH);
  await saveStats(server.stats, STATS_PATH);
  await saveLedger(server.ledger, LEDGER_PATH);
  await server.stop();
  console.log("World + stats + ledger saved. Bye.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
