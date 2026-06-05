/**
 * Top-down grid projection + Wonderland-inspired tile palette.
 *
 * Light squares are a uniform parchment cream — they give the board its
 * classical chess rhythm. Dark squares carry the colour: each one rolls a
 * type from a hash of (x, y), so the world looks the same to every client
 * without any server-side terrain data.
 *
 * Each tile *type* has a mock effect string we'll wire to real gameplay
 * later — for now it's pure flavour and a HUD tooltip.
 */

export const CELL = 56;

export function worldToScreen(x: number, y: number): { sx: number; sy: number } {
  return { sx: x * CELL, sy: y * CELL };
}

export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return { x: sx / CELL, y: sy / CELL };
}

export type TileType = "light" | "dusk" | "champagne" | "lavender-stone" | "teal-mist" |
  "midnight-moss" | "candy-shrine" | "molten-amber" | "absinthe";

export interface TileTypeDef {
  color: number;
  label: string;
  effect: string;
  accent?: number;
}

/**
 * Palette: Alice-in-Wonderland dream + faint bitcoin amber accent.
 * Light squares are always parchment. Dark squares draw from the rest.
 */
export const TILE_DEFS: Record<TileType, TileTypeDef> = {
  "light":          { color: 0xede4d3, label: "Parchment", effect: "neutral light square" },
  "dusk":           { color: 0x3a2438, label: "Dusk",      effect: "neutral dark square" },
  "champagne":      { color: 0xc9a86a, label: "Champagne", effect: "−1 cooldown · pieces sprint",          accent: 0xf6e0a8 },
  "lavender-stone": { color: 0x4d3f63, label: "Lavender Stone", effect: "+1 defense · pieces hold ground", accent: 0x9b86c0 },
  "teal-mist":      { color: 0x205e6c, label: "Teal Mist", effect: "passable but slow · +2 cooldown",      accent: 0x69bccd },
  "midnight-moss":  { color: 0x1f3a2a, label: "Midnight Moss", effect: "concealed · enemy can't see in",    accent: 0x4a8060 },
  "candy-shrine":   { color: 0xc04a8a, label: "Candy Shrine", effect: "blesses king (heal mock)",          accent: 0xffd86b },
  "molten-amber":   { color: 0xd5572a, label: "Molten Amber", effect: "burns! piece takes damage",          accent: 0xffae5a },
  "absinthe":       { color: 0x4a6638, label: "Absinthe",  effect: "slows + poisons enemies",              accent: 0x9bcc55 },
};

function hash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

/**
 * White (light parity) cells are ALWAYS `light` — they carry the chess pattern.
 * Black (dark parity) cells draw a type from the dark palette so the board
 * sings with colour but the rhythm stays legible.
 */
export function tileTypeAt(x: number, y: number): TileType {
  if ((x + y) % 2 === 0) return "light";
  const r = hash01(x, y);
  if (r < 0.70) return "dusk";
  if (r < 0.80) return "champagne";
  if (r < 0.87) return "lavender-stone";
  if (r < 0.92) return "teal-mist";
  if (r < 0.95) return "midnight-moss";
  if (r < 0.975) return "candy-shrine";
  if (r < 0.99) return "molten-amber";
  return "absinthe";
}

/** Render colour. Light cells get a tiny jitter so they're not perfectly flat;
 * dark cells get a slightly bigger jitter for painterly variety. */
export function tileColor(x: number, y: number): number {
  const type = tileTypeAt(x, y);
  const def = TILE_DEFS[type];
  const isLight = type === "light";
  const j = hash01(x + 9001, y - 4242);
  const jitter = Math.floor((j - 0.5) * (isLight ? 6 : 18));
  const r = clampByte(((def.color >> 16) & 0xff) + jitter);
  const g = clampByte(((def.color >> 8) & 0xff) + jitter);
  const b = clampByte((def.color & 0xff) + jitter);
  return (r << 16) | (g << 8) | b;
}

/** Light cells have no accent. Dark cells with a stronger flavour do. */
export function tileAccent(x: number, y: number): number | null {
  return TILE_DEFS[tileTypeAt(x, y)].accent ?? null;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
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
