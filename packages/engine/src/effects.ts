/**
 * Board effects — the data-driven hook that lets terrain, buildings, and
 * artifacts change the rules of the board.
 *
 * The move generator reads a BoardEffects alongside the PieceRegistry. The
 * world builds one of these each turn from whatever entities sit on or near the
 * board (a building makes a square impassable; an artifact grants nearby pieces
 * extra moves). New effect *types* are added here and consumed in moves.ts —
 * never by special-casing individual artifacts in the generator.
 *
 * This is the seam a future scripting/plugin system would back: today the
 * effects are plain data + closures; tomorrow they could be sandboxed scripts.
 */

import type { Square, Vec } from "./types.js";

export interface BoardEffects {
  /** Squares pieces may not enter or slide through (walls, buildings). */
  blocked?: ReadonlySet<Square>;
  /** Extra leaper offsets granted to the piece on `sq` (auras). e.g. a shrine
   * that lets a nearby rook also jump like a knight. */
  grantHops?: (sq: Square) => readonly Vec[];
}

/** Convenience: an effects object with nothing active. */
export const NO_EFFECTS: BoardEffects = {};

export function isBlocked(effects: BoardEffects, sq: Square): boolean {
  return effects.blocked?.has(sq) ?? false;
}

export function grantedHops(effects: BoardEffects, sq: Square): readonly Vec[] {
  return effects.grantHops?.(sq) ?? [];
}
