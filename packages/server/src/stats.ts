/**
 * Persistent per-name stats: ELO, wins, losses, kills, deaths.
 *
 * Keyed by player name (the same name the client supplies on `join`). For a
 * real deployment this becomes a per-account row in Postgres; for now it's a
 * JSON file on disk so stats survive restarts.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface PlayerStats {
  elo: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  /** Lightning sats balance. Starter grant + earn-on-kill. */
  sats: number;
}

export const STARTING_ELO = 1000;
export const ELO_K = 32;
export const STARTING_SATS = 10_000;
/** On a king kill / mate, killer takes this fraction of victim's current sats. */
export const KILL_SATS_SHARE = 0.25;
/** Minimum sats a kill awards even if the victim is broke. */
export const KILL_SATS_MIN = 500;

export function newStats(): PlayerStats {
  return { elo: STARTING_ELO, wins: 0, losses: 0, kills: 0, deaths: 0, sats: STARTING_SATS };
}

/** Standard ELO update for a 1v1 result (1 = winner, 0 = loser). */
export function eloDelta(myElo: number, opponentElo: number, score: 0 | 1): number {
  const expected = 1 / (1 + Math.pow(10, (opponentElo - myElo) / 400));
  return Math.round(ELO_K * (score - expected));
}

export class StatsStore {
  private byName = new Map<string, PlayerStats>();

  get(name: string): PlayerStats {
    let s = this.byName.get(name);
    if (!s) {
      s = newStats();
      this.byName.set(name, s);
    }
    return s;
  }

  /** Apply a kill: winner kills loser. Mutates both. Returns ELO + sats deltas. */
  applyKill(winnerName: string, loserName: string): {
    winnerDelta: number;
    loserDelta: number;
    satsTransferred: number;
  } {
    const winner = this.get(winnerName);
    const loser = this.get(loserName);
    const wd = eloDelta(winner.elo, loser.elo, 1);
    const ld = eloDelta(loser.elo, winner.elo, 0);
    winner.elo += wd;
    loser.elo += ld;
    winner.wins += 1;
    loser.losses += 1;
    const take = Math.max(KILL_SATS_MIN, Math.floor(loser.sats * KILL_SATS_SHARE));
    const actually = Math.min(take, loser.sats);
    loser.sats -= actually;
    winner.sats += actually;
    return { winnerDelta: wd, loserDelta: ld, satsTransferred: actually };
  }

  serialize(): Record<string, PlayerStats> {
    return Object.fromEntries(this.byName);
  }

  loadFrom(data: Record<string, PlayerStats>): void {
    this.byName.clear();
    for (const [name, s] of Object.entries(data ?? {})) {
      // Defensive defaults so older save files still load.
      this.byName.set(name, {
        elo: s.elo ?? STARTING_ELO,
        wins: s.wins ?? 0,
        losses: s.losses ?? 0,
        kills: s.kills ?? 0,
        deaths: s.deaths ?? 0,
        sats: s.sats ?? STARTING_SATS,
      });
    }
  }
}

export async function saveStats(store: StatsStore, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(store.serialize(), null, 2), "utf8");
}

export async function loadStats(store: StatsStore, path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const raw = await readFile(path, "utf8");
  store.loadFrom(JSON.parse(raw));
  return true;
}
