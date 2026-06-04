/**
 * Data-driven piece definitions.
 *
 * A piece's movement is described declaratively:
 *   - `rides`: sliding moves along directions, up to `range` squares (a rook
 *     rides orthogonally with infinite range; a bishop rides diagonally).
 *   - `hops`: fixed offset jumps that ignore blockers (a knight, a king step).
 *
 * Pawns are intentionally special-cased in the engine because their rules are
 * asymmetric (move vs. capture, double-step, en passant, promotion). Everything
 * else is expressed purely as data, so new pieces are added here, not in the
 * move generator. This is the seam your "custom rules / artifacts" features
 * will extend.
 */

import type { PieceTypeId, Vec } from "./types.js";

export interface RidePattern {
  dirs: readonly Vec[];
  /** Max squares per ride. Use Infinity for unlimited sliders. */
  range: number;
}

export interface PieceDef {
  id: PieceTypeId;
  rides?: readonly RidePattern[];
  hops?: readonly Vec[];
  /** Royal pieces (the king) define check / loss conditions. */
  isRoyal?: boolean;
  /** Pawns get bespoke generation; flagged so the engine can branch once. */
  isPawn?: boolean;
}

const ORTHOGONAL: readonly Vec[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIAGONAL: readonly Vec[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const ALL_8: readonly Vec[] = [...ORTHOGONAL, ...DIAGONAL];

const KNIGHT_HOPS: readonly Vec[] = [
  [1, 2],
  [2, 1],
  [-1, 2],
  [-2, 1],
  [1, -2],
  [2, -1],
  [-1, -2],
  [-2, -1],
];

export const STANDARD_PIECES: Record<string, PieceDef> = {
  pawn: { id: "pawn", isPawn: true },
  knight: { id: "knight", hops: KNIGHT_HOPS },
  bishop: { id: "bishop", rides: [{ dirs: DIAGONAL, range: Infinity }] },
  rook: { id: "rook", rides: [{ dirs: ORTHOGONAL, range: Infinity }] },
  queen: { id: "queen", rides: [{ dirs: ALL_8, range: Infinity }] },
  king: { id: "king", hops: ALL_8, isRoyal: true },
};

/**
 * A registry lets a game variant (or a future server-side rules module) supply
 * its own piece set. The engine reads piece behaviour from here, so a colorful
 * open-world variant can register exotic pieces without touching engine code.
 */
export class PieceRegistry {
  private defs = new Map<PieceTypeId, PieceDef>();

  constructor(initial: Record<string, PieceDef> = STANDARD_PIECES) {
    for (const def of Object.values(initial)) this.register(def);
  }

  register(def: PieceDef): void {
    this.defs.set(def.id, def);
  }

  get(id: PieceTypeId): PieceDef {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Unknown piece type: ${id}`);
    return def;
  }

  has(id: PieceTypeId): boolean {
    return this.defs.has(id);
  }
}

export { ORTHOGONAL, DIAGONAL, ALL_8, KNIGHT_HOPS };
