/**
 * Move generation on an infinite plane, with check-aware filtering.
 *
 * Differs from board.ts (8x8):
 *  - No bounds: rides extend until they hit a piece or `range`.
 *  - No castling, no en passant.
 *  - Pawns advance toward their `forward` direction. First move (when
 *    `hasMoved` is false) may advance two squares if both are empty.
 *  - Standard chess check rule: a move that leaves the mover's own king
 *    attacked is illegal. `legalMovesPlaneFiltered` enforces this.
 *
 * Reuses the same PieceDef rides/hops from the registry, so custom pieces
 * still work unchanged.
 */

import type { PieceDef, PieceRegistry } from "./pieces.js";
import type { Vec } from "./types.js";

export interface PlanePiece {
  owner: string;
  type: string;
  forward?: Vec;
  hasMoved?: boolean;
}

export type Occupant = (PlanePiece & { x: number; y: number }) | null;

export interface PlaneMove {
  x: number;
  y: number;
  capture: boolean;
}

/** Raw legal moves ignoring own-king-check rules. */
export function legalMovesPlane(
  piece: PlanePiece,
  x: number,
  y: number,
  registry: PieceRegistry,
  getOccupant: (x: number, y: number) => Occupant,
  maxRideRange = 32
): PlaneMove[] {
  const def: PieceDef = registry.get(piece.type);
  const out: PlaneMove[] = [];

  if (def.isPawn) {
    const fwd = piece.forward ?? [0, -1];
    const fx = x + fwd[0];
    const fy = y + fwd[1];
    if (getOccupant(fx, fy) === null) {
      out.push({ x: fx, y: fy, capture: false });
      // Double-step from spawn: only if hasMoved is false and both squares empty.
      if (!piece.hasMoved) {
        const f2x = x + fwd[0] * 2;
        const f2y = y + fwd[1] * 2;
        if (getOccupant(f2x, f2y) === null) {
          out.push({ x: f2x, y: f2y, capture: false });
        }
      }
    }
    const perps: Vec[] = [
      [fwd[1], -fwd[0]],
      [-fwd[1], fwd[0]],
    ];
    for (const p of perps) {
      const dx = x + fwd[0] + p[0];
      const dy = y + fwd[1] + p[1];
      const occ = getOccupant(dx, dy);
      if (occ && occ.owner !== piece.owner) out.push({ x: dx, y: dy, capture: true });
    }
    return out;
  }

  if (def.hops) {
    for (const [dx, dy] of def.hops) {
      const tx = x + dx;
      const ty = y + dy;
      const occ = getOccupant(tx, ty);
      if (occ === null) out.push({ x: tx, y: ty, capture: false });
      else if (occ.owner !== piece.owner) out.push({ x: tx, y: ty, capture: true });
    }
  }

  if (def.rides) {
    for (const ride of def.rides) {
      const range = Math.min(ride.range, maxRideRange);
      for (const [dx, dy] of ride.dirs) {
        for (let step = 1; step <= range; step++) {
          const tx = x + dx * step;
          const ty = y + dy * step;
          const occ = getOccupant(tx, ty);
          if (occ === null) {
            out.push({ x: tx, y: ty, capture: false });
            continue;
          }
          if (occ.owner !== piece.owner) out.push({ x: tx, y: ty, capture: true });
          break;
        }
      }
    }
  }

  return out;
}

/**
 * Is square (x, y) attacked by any piece owned by someone OTHER than `defenderOwner`?
 * "Attacked" = some enemy piece's legal move set includes (x, y), ignoring check
 * legality (an attacker doesn't have to be free to actually move there for it to
 * be "attacking" — that's how chess attack is defined).
 *
 * `allPieces` is the iterable of every piece relevant to the check (typically
 * everything within ride-range of the defender's king).
 */
export function squareAttackedBy(
  x: number,
  y: number,
  defenderOwner: string,
  allPieces: Iterable<PlanePiece & { x: number; y: number }>,
  registry: PieceRegistry,
  getOccupant: (x: number, y: number) => Occupant,
  maxRideRange = 32
): boolean {
  for (const p of allPieces) {
    if (p.owner === defenderOwner) continue;
    const moves = legalMovesPlane(p, p.x, p.y, registry, getOccupant, maxRideRange);
    for (const m of moves) if (m.x === x && m.y === y) return true;
  }
  return false;
}

/**
 * Legal moves for `piece` that do NOT leave the mover's own king in check.
 * Performs an O(moves * attackers) simulation per move — fine for army-sized
 * counts. Caller provides the world's piece set + king lookup.
 */
export function legalMovesPlaneFiltered(
  piece: PlanePiece & { x: number; y: number },
  registry: PieceRegistry,
  getOccupant: (x: number, y: number) => Occupant,
  allPieces: () => Iterable<PlanePiece & { x: number; y: number }>,
  findKing: (owner: string) => { x: number; y: number } | null,
  maxRideRange = 32
): PlaneMove[] {
  const raw = legalMovesPlane(piece, piece.x, piece.y, registry, getOccupant, maxRideRange);
  const out: PlaneMove[] = [];
  for (const m of raw) {
    if (!leavesOwnKingInCheck(piece, m.x, m.y, registry, getOccupant, allPieces, findKing, maxRideRange)) {
      out.push(m);
    }
  }
  return out;
}

/** Simulate `piece` moving from (piece.x, piece.y) to (toX, toY) and check whether
 * the mover's king is attacked afterwards. */
export function leavesOwnKingInCheck(
  piece: PlanePiece & { x: number; y: number },
  toX: number,
  toY: number,
  registry: PieceRegistry,
  getOccupant: (x: number, y: number) => Occupant,
  allPieces: () => Iterable<PlanePiece & { x: number; y: number }>,
  findKing: (owner: string) => { x: number; y: number } | null,
  maxRideRange = 32
): boolean {
  const fromX = piece.x;
  const fromY = piece.y;
  // What the captured piece (if any) is — we need to exclude it from sim.
  const captured = getOccupant(toX, toY);
  // Simulated occupant lookup: redirect the moving piece, hide the captured.
  const simOccupant = (x: number, y: number): Occupant => {
    if (x === fromX && y === fromY) return null;
    if (x === toX && y === toY) return { ...piece, x: toX, y: toY };
    return getOccupant(x, y);
  };
  // Determine king position after the simulated move.
  let kingX: number;
  let kingY: number;
  if (piece.type === "king") {
    kingX = toX;
    kingY = toY;
  } else {
    const k = findKing(piece.owner);
    if (!k) return false; // no king = no check rule applies
    kingX = k.x;
    kingY = k.y;
  }
  // Build a virtual pieces iterable that omits captured and relocates the mover.
  const simPieces = function* () {
    for (const p of allPieces()) {
      if (captured && p.owner === captured.owner && p.x === toX && p.y === toY) continue;
      if (p.x === fromX && p.y === fromY) {
        yield { ...piece, x: toX, y: toY };
      } else {
        yield p;
      }
    }
  };
  return squareAttackedBy(kingX, kingY, piece.owner, simPieces(), registry, simOccupant, maxRideRange);
}

/** Simple legality check used by the server when applying a move. */
export function isLegalPlaneMove(
  piece: PlanePiece,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  registry: PieceRegistry,
  getOccupant: (x: number, y: number) => Occupant,
  maxRideRange = 32
): boolean {
  const moves = legalMovesPlane(piece, fromX, fromY, registry, getOccupant, maxRideRange);
  return moves.some((m) => m.x === toX && m.y === toY);
}
