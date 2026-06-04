/**
 * Durable world state. A real deployment puts this in Postgres (per Nakama's
 * model); for the slice we snapshot to a JSON file so the world genuinely
 * persists across restarts — proving the persistence seam exists.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { World, PersistedWorld } from "./world.js";

export async function saveWorld(world: World, path: string): Promise<void> {
  const data = world.serialize();
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

export async function loadWorld(world: World, path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const raw = await readFile(path, "utf8");
  const data = JSON.parse(raw) as PersistedWorld;
  world.load(data);
  return true;
}
