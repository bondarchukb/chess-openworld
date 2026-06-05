/**
 * Top-down grid projection.
 *
 * Each world tile is a CELL x CELL square. World (x,y) maps directly to
 * screen pixels (x*CELL, y*CELL). Simple, readable, leaves room for big
 * piece sprites and per-army color skins.
 */

export const CELL = 56;

export function worldToScreen(x: number, y: number): { sx: number; sy: number } {
  return { sx: x * CELL, sy: y * CELL };
}

/** Inverse: screen pixels -> world tile coords (continuous). Linear, so works for deltas too. */
export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return { x: sx / CELL, y: sy / CELL };
}

/** Subtle checkerboard so the plane reads as a grid. */
export function tileColor(x: number, y: number): number {
  return (x + y) % 2 === 0 ? 0x2a223d : 0x231b32;
}

const PIECE_GLYPH: Record<string, string> = {
  pawn: "♟",
  knight: "♞",
  bishop: "♝",
  rook: "♜",
  queen: "♛",
  king: "♚",
};

export function pieceGlyph(type: string): string {
  return PIECE_GLYPH[type] ?? "?";
}
