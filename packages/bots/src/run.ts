/**
 * CLI runner: `npm run bots -- <count> [url]`
 *
 * Example:
 *   npm run bots -- 4
 *   npm run bots -- 6 ws://localhost:8080
 */

import { Bot } from "./bot.js";

const ADJECTIVES = ["Greedy", "Bold", "Sneaky", "Calm", "Rash", "Quiet", "Loud", "Wise", "Mad", "Cold"];
const NOUNS = ["Knight", "Bishop", "Rook", "Queen", "Pawn", "King", "Hawk", "Wolf", "Fox", "Bear"];

function botName(i: number): string {
  const a = ADJECTIVES[i % ADJECTIVES.length] ?? "Bot";
  const n = NOUNS[(i * 3 + 1) % NOUNS.length] ?? "X";
  return `${a}${n}${i}`;
}

const count = Number(process.argv[2] ?? 4);
const url = process.argv[3] ?? process.env.BOTS_URL ?? "ws://localhost:8080";

console.log(`Spawning ${count} bots → ${url}`);

const bots: Bot[] = [];
for (let i = 0; i < count; i++) {
  bots.push(
    new Bot({
      url,
      name: botName(i),
      spawnMode: i % 2 === 0 ? "classical" : "blob",
      tickIntervalMs: 2500 + Math.floor(Math.random() * 1500),
    })
  );
  // Small stagger so they don't all hit the server at once.
  await new Promise((r) => setTimeout(r, 200));
}

function shutdown(): void {
  console.log("Stopping bots…");
  for (const b of bots) b.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
