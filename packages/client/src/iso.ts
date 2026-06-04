/**
 * Isometric projection + the colorful palette.
 *
 * Tiles are diamonds (2:1). We render in "2.5D": ground diamonds plus upright
 * sprites for pieces/buildings, which reads as depth without any 3D engine —
 * exactly the colorful, non-black-and-white look we're after.
 */

export const TILE_W = 64;
export const TILE_H = 32;

/** World tile (x,y) -> screen pixel (relative to camera origin). */
export function isoToScreen(x: number, y: number): { sx: number; sy: number } {
  return {
    sx: (x - y) * (TILE_W / 2),
    sy: (x + y) * (TILE_H / 2),
  };
}

/** Checkerboard-ish ground tint so the world is colorful, not monochrome. */
export function tileColor(x: number, y: number, isBoard: boolean): number {
  if (isBoard) {
    return (x + y) % 2 === 0 ? 0xf0d9b5 : 0xb58863; // classic board, but warm
  }
  const pattern = (x * 7 + y * 13) % 5;
  return [0x2e7d52, 0x35915f, 0x2a6e4a, 0x3a9d68, 0x2f7a55][pattern]!;
}

export const ENTITY_STYLE: Record<string, { color: number; glyph: string }> = {
  player: { color: 0x4ea3ff, glyph: "☻" },
  building: { color: 0x9b6b3a, glyph: "🏰" },
  artifact: { color: 0xff5fd0, glyph: "✦" },
  piece: { color: 0xffffff, glyph: "♟" },
};

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
