/**
 * Wire protocol shared between client and server.
 *
 * The whole MMO is built on these rules:
 *  - Clients send *intents* (ClientMessage). They never assert world state.
 *  - The server validates every intent and broadcasts authoritative results
 *    (ServerMessage) only to players whose interest set is affected.
 *
 * Keeping this in a shared package means client and server can never disagree
 * about the message shape — a big reason to use TypeScript end-to-end.
 */

/** World layout constants. A future deployment can shard zones across servers. */
export const WORLD = {
  /** World size in tiles. */
  width: 192,
  height: 192,
  /** Zone (chunk) edge length in tiles. World is width/zoneSize zones wide. */
  zoneSize: 24,
  /** Server simulation rate. */
  tickHz: 10,
} as const;

export type EntityId = string;

export type Color = "white" | "black";

// ---- Monetization: cosmetic skins (Lightning) ------------------------------

/** Where a skin applies. Only avatars today; pieces/buildings can follow. */
export type SkinSlot = "avatar";

/** A purchasable cosmetic. Prices are in sats (1 BTC = 100,000,000 sats).
 * Skins are PURELY cosmetic — they never affect rules, so this is not
 * pay-to-win and stays clear of gambling/real-money-gaming regulation. */
export interface SkinItem {
  id: string;
  name: string;
  slot: SkinSlot;
  priceSats: number;
}

/** The shop catalog. Shared so client and server agree on ids and prices;
 * the server still treats its own copy as authoritative for charging. */
export const SKINS: readonly SkinItem[] = [
  { id: "gold", name: "Gold Champion", slot: "avatar", priceSats: 500 },
  { id: "ninja", name: "Shadow Ninja", slot: "avatar", priceSats: 1000 },
  { id: "wizard", name: "Arcane Wizard", slot: "avatar", priceSats: 2100 },
];

export function skinById(id: string): SkinItem | undefined {
  return SKINS.find((s) => s.id === id);
}

/** A player's cosmetic entitlements: what they own and what they're wearing. */
export interface Wallet {
  owned: string[];
  equipped: { avatar?: string };
}

/** Kinds of things that live on a tile in the open world. */
export type EntityKind = "player" | "piece" | "building" | "artifact";

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  x: number;
  y: number;
  /** For players: display name. For pieces: piece type id (pawn, knight, ...). */
  label: string;
  color?: Color;
  /** Purely cosmetic skin id — never affects rules. */
  skin?: string;
}

/** Authoritative state of the shared demo chess board embedded in the world. */
export interface BoardSnapshot {
  /** World-tile origin of the board's a1 square. */
  originX: number;
  originY: number;
  /** 64 cells, row-major from rank 1; null or "color:type". */
  cells: (string | null)[];
  sideToMove: Color;
  /** "playing" | "check" | "checkmate" | "stalemate" | "draw". */
  status: string;
  /** Player ids occupying each seat, or null if open. */
  seatWhite: EntityId | null;
  seatBlack: EntityId | null;
  /** Board squares (0..63) made impassable by terrain/buildings. */
  blocked: number[];
}

// ---- Client -> Server -------------------------------------------------------

export type ClientMessage =
  /** `accountId` is a client-generated id (stored in localStorage) that ties
   * purchases to a person across sessions — a minimal stand-in for accounts. */
  | { t: "join"; name: string; accountId?: string }
  | { t: "move"; dx: number; dy: number } // step the avatar by one tile
  | { t: "place"; kind: Extract<EntityKind, "building" | "artifact">; skin?: string }
  /** Move on the shared chess board. `promotion` selects the piece when a pawn
   * reaches the back rank (defaults to queen). */
  | { t: "boardMove"; from: number; to: number; promotion?: string }
  /** Claim an open seat (White, then Black) at the shared board. */
  | { t: "sit" }
  /** Reset the board to a fresh game (allowed once the game has ended). */
  | { t: "newGame" }
  /** Tell the server where the camera is looking, so it streams interest there
   * too (spectator panning). Cleared by sending a focus on the avatar. */
  | { t: "focus"; x: number; y: number }
  /** Request a Lightning invoice to buy a skin. Server replies with `invoice`. */
  | { t: "buySkin"; skinId: string }
  /** Wear (or remove, with null) an owned skin in a slot. */
  | { t: "equipSkin"; slot: SkinSlot; skinId: string | null }
  /** DEV/MOCK ONLY: simulate paying an invoice. Ignored by real providers. */
  | { t: "devPay"; invoiceId: string }
  | { t: "chat"; text: string }
  | { t: "ping" };

// ---- Server -> Client -------------------------------------------------------

export interface SelfInfo {
  id: EntityId;
  x: number;
  y: number;
}

export type ServerMessage =
  | { t: "welcome"; you: SelfInfo; world: typeof WORLD; board: BoardSnapshot }
  /** Full set of entities currently inside the player's interest region. */
  | { t: "snapshot"; entities: Entity[] }
  /** Incremental interest update produced each server tick. */
  | {
      t: "delta";
      enter: Entity[];
      leave: EntityId[];
      move: { id: EntityId; x: number; y: number }[];
    }
  | { t: "board"; board: BoardSnapshot }
  /** The player's current entitlements (sent on join and after any change). */
  | { t: "wallet"; wallet: Wallet }
  /** A Lightning invoice to pay for a pending skin purchase. */
  | { t: "invoice"; invoiceId: string; skinId: string; bolt11: string; amountSats: number }
  /** A purchase settled — the skin is now owned. */
  | { t: "purchased"; skinId: string }
  | { t: "chat"; from: string; text: string }
  | { t: "error"; message: string }
  | { t: "pong" };

/** Zone index for a tile, and the helper to enumerate a Moore-neighborhood. */
export function zoneOf(x: number, y: number): number {
  const zx = Math.floor(x / WORLD.zoneSize);
  const zy = Math.floor(y / WORLD.zoneSize);
  const zonesWide = Math.ceil(WORLD.width / WORLD.zoneSize);
  return zy * zonesWide + zx;
}

/** The set of zone ids a player at (x,y) is interested in (self + 8 neighbors). */
export function interestZones(x: number, y: number): Set<number> {
  const zonesWide = Math.ceil(WORLD.width / WORLD.zoneSize);
  const zonesTall = Math.ceil(WORLD.height / WORLD.zoneSize);
  const zx = Math.floor(x / WORLD.zoneSize);
  const zy = Math.floor(y / WORLD.zoneSize);
  const set = new Set<number>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = zx + dx;
      const ny = zy + dy;
      if (nx < 0 || ny < 0 || nx >= zonesWide || ny >= zonesTall) continue;
      set.add(ny * zonesWide + nx);
    }
  }
  return set;
}
