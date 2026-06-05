# Open-plane chess MMO — spec

Living spec. Captures current state + planned features. Server is authoritative.

## Current

- Infinite plane (string-keyed zones, negative coords ok).
- Each player owns one army (16 pieces, standard chess setup). Unique color.
- Real-time movement. Each piece has a cooldown after moving (`WORLD.pieceCooldownMs`, currently 6 s).
- Standard chess movement (rides + hops + pawn). Pawn forward direction set at army spawn.
- **Pawn skill — Reorient**: rotate pawn's forward vector to one of 4 cardinals.
  Long cooldown (`WORLD.reorientCooldownMs`, 20 s). Reorient consumes the same
  `readyAt` field as a move, so it's a real action, not a free swap. Hotkeys
  `1`/`2`/`3`/`4` while own pawn selected = up/right/down/left.
- Capturing an enemy **king** wipes that army; server respawns it elsewhere.
- Interest streaming: 3x3 zone neighborhood around camera focus.
- Persistence: id counters only (armies recreated on connect).
- Top-down 2D render. Camera pan WASD/arrows/drag, wheel zoom, C recenter, Esc deselect.
- Client name persisted in `localStorage`.

## First skill implemented — Reorient (pawn)

Reorient is the first concrete instance of the per-piece skill system. It uses
the existing `piece.readyAt` for cooldown instead of a separate skill cooldown
field, which keeps the protocol minimal at the cost of coupling move and skill
cooldowns into one resource. When the skill system in `Planned` lands, reorient
will migrate to `skillCooldowns["reorient"]` and free `readyAt` to mean
move-only cooldown again. Until then: reorient = move-equivalent action.

## Planned — per-piece skills (DOTA-style)

Each piece type gets a small skill kit (1–3 actives, sometimes a passive). Skills
are **data**, defined in the engine registry alongside `rides`/`hops`, so the
authoritative server validates them and clients render their effects identically.

### Skill shape (sketch)

```ts
interface Skill {
  id: string;                 // "knight-charge", "rook-quake"
  name: string;
  cooldownMs: number;
  range: number;              // tiles from caster, 0 = self
  target: "tile" | "piece" | "self" | "direction";
  cost?: { mana?: number; hp?: number };
  effect: SkillEffect;        // declarative — see below
}

type SkillEffect =
  | { kind: "dash"; dirs: Vec[]; tiles: number }
  | { kind: "stun"; durationMs: number; radius: number }
  | { kind: "damage"; amount: number; radius: number }
  | { kind: "shield"; absorb: number; durationMs: number }
  | { kind: "teleport"; pattern: "ride" | "swap" }
  | { kind: "summon"; pieceType: string };
```

### Starter kit (illustrative — not final)

| Piece | Active 1 | Active 2 | Passive |
|-------|----------|----------|---------|
| Pawn | **Reorient** — pick a new forward cardinal (20s CD, already shipped) | **Lock Shield** — block 1 incoming capture (8s CD) | gains promotion options after surviving 3 captures |
| Knight | **Charge** — extra knight-hop, no cooldown applied (12s CD) | **Hoofquake** — stun adjacent 1.5s (20s CD) | ignores cooldown on capture |
| Bishop | **Beam** — long-range attack along diagonal, blocked by terrain (15s CD) | **Bless** — clear cooldown on adjacent allied piece (25s CD) | — |
| Rook | **Quake** — stun all enemies in same row/file within 4 tiles (30s CD) | **Wall** — leave impassable rubble in trail for 10s (20s CD) | bonus range +2 after capture |
| Queen | **Teleport** — swap with any friendly piece in sight (25s CD) | **Storm** — damage 3x3 around any visible tile (40s CD) | — |
| King | **Rally** — halve cooldowns of friendlies within 3 tiles (60s CD) | **Last Stand** — invuln 2s when below 25% (90s CD) | death = army wipe (existing rule) |

### Health / mana

Add to `Piece`:
```ts
hp: number;      // standard pieces start at 1; bosses higher
maxHp: number;
mana: number;
maxMana: number;
manaRegenPerSec: number;
```

Damage skills can take >1 hp from special pieces. Standard captures still
1-shot. This keeps chess capture semantics while letting skills layer on.

### Wire protocol additions

```ts
| { t: "castSkill"; pieceId: PieceId; skillId: string;
    target?: { x: number; y: number } | { pieceId: PieceId } }
```

Server validates: ownership, cooldown, range, mana, line-of-sight. Broadcasts
`{ t: "skillEffect", ... }` to all players in affected zones for animation.

### Implementation order

1. `Piece` gains `hp/maxHp/mana/maxMana/cooldowns: Record<SkillId, number>`.
2. Engine: `legalSkillTargets(piece, skill, getOccupant)`.
3. Server: `tryCastSkill(pieceId, skillId, target)`; per-skill resolver lookup.
4. Client: skill hotbar shown when own piece selected (1, 2, 3 keys).
5. Particle/flash render for `skillEffect` events.

## Stakes / progression (shipped)

- **ELO ranking** (start 1000, K=32). Persisted per name in `stats.json`.
  Killing an enemy king or checkmating awards ELO; victim loses ELO.
- **W/L/K/D** tracked alongside ELO.
- **30s respawn delay**. Pieces wipe immediately on death; respawn timer runs.
  Dead overlay shows killer + ELO delta + countdown.
- Roster broadcasts each army's ELO + dead flag; compass labels show it.

## Spawn modes (shipped)

- **Classical** — standard 8 back-rank + 8 pawns, facing one cardinal.
- **Blob** — same 16 pieces, randomly scattered in a 5x5 area. No formation,
  pawns still face the army's forward.

Chosen at entry screen, persisted in `localStorage`. Server respects it on every
respawn for that player.

## Planned — paid tier (NOT yet shipped)

- **Custom spawn layout** — design your own placement of the 16 pieces (or a
  larger limit). Save as a named template. Server validates count + ranges.
  Behind a paywall once monetization lands.
- **Custom piece builder** — author your own piece type with:
  - shape / glyph / skin (cosmetic)
  - movement pattern (rides + hops at custom directions/ranges)
  - attack pattern (which squares it threatens — may differ from movement, like
    pawn)
  - max HP / max mana / regen
  - skill kit (1–3 skills from the skill system)
  - ELO / point cost (so armies with custom pieces cost roster slots)
  The builder serializes to a `PieceDef` extension that the engine registry
  loads, so adding a piece does NOT require engine changes — just data. Behind
  paywall once monetization lands.

## Planned — pre-game shop (free + paid)

A loadout screen between deaths (and on first join) where the player spends
**gold** on consumables, semi-durables, and customs before respawning.

### Currency

- **Gold** — earned per piece captured (e.g. pawn = 1, knight/bishop = 3,
  rook = 5, queen = 9, king = 25 + ELO bonus). Persisted per name in
  `stats.json` (extend `PlayerStats` with `gold`).
- Gold is separate from ELO. ELO = rank. Gold = currency.
- No purchase of ELO ever. ELO must stay competitive integrity.

### Shop opens

1. First join (after entry screen, before army spawns).
2. During the 30 s respawn timer (replaces the plain countdown overlay).
3. Optional always-available button (peek + buy, can't change running army).

### Item catalog

Costs are sketches — final balance after playtesting.

**Mobility / positioning**

| Item | Cost | Effect |
|---|---|---|
| **Teleport scroll** | 10g | Move any owned piece to any tile within 8. Hotkey `T`. |
| **Recall scroll** | 6g | Return one piece to your last spawn center. |
| **Swap scroll** | 12g | Swap positions of two of your pieces (any distance). |
| **Phase walk** | 15g | Move one piece *through* up to 2 enemy pieces (capture none). One step further than its normal max. |
| **Backstep** | 4g | Move a piece 1 tile in the *opposite* of its forward / last direction. Escape tool. |
| **Long jump** | 8g | Knight gets +1 reach on its next hop. |
| **Cavalry charge** | 14g | Knight makes two hops in a row, ignoring cooldown between them. |

**Defense**

| Item | Cost | Effect |
|---|---|---|
| **Shield charge** | 8g | Next capture against this piece fails. Stacks per piece. |
| **Aegis** | 20g | Three pieces in a 3x3 around target tile each gain +1 shield. |
| **Decoy** | 6g | Place a fake pawn on an adjacent tile. Dies in 1 hit, no real effect, but enemies often spend a piece on it. |
| **King's guard** | 25g | King is uncapturable for 8s. Visible halo to enemies. |
| **Stone skin** | 10g | Piece can't be captured for 10s but also can't move. |
| **Smokescreen** | 9g | Enemies within 3 tiles of caster fail their next capture against any of your pieces. |

**Offense**

| Item | Cost | Effect |
|---|---|---|
| **Cooldown reset** | 6g | One piece's `readyAt` → 0 immediately. |
| **Berserk** | 12g | Picked piece's cooldown is halved for its next 3 moves. |
| **Sniper sight** | 14g | Bishop's next capture passes through 1 blocker. |
| **Cleave** | 10g | Knight's next capture also kills one enemy adjacent to its destination. |
| **Flame strike** | 18g | Target a tile within 6. After 3s cast, any enemy on it dies. Visible warning to all. |
| **Mark** | 5g | Tag one enemy piece. Your pieces get +1 effective range against it for 15s. |
| **Battering ram** | 11g | Rook pushes through one of your own pieces, swapping with it as it rides. |

**Resource / economy**

| Item | Cost | Effect |
|---|---|---|
| **Gold pouch** | 10g | Next kill yields +10g bonus. |
| **Salvage** | 0g (passive unlock 15g) | Captures refund 50% of victim's value. |
| **Mercenary contract** | 25g | Next enemy piece you capture becomes yours for 60s, then dies. |

**Information / vision**

| Item | Cost | Effect |
|---|---|---|
| **Spyglass** | 8g | Reveal every enemy army's piece count + ELO for 60s. |
| **Threat detector** | 5g | Briefly highlight all enemy pieces whose move set includes your king's square. |
| **Scout drone** | 7g | Spawn a ghost pawn that walks 8 tiles in a chosen direction. Sees but can't capture. |
| **Ping** | 1g | Drop a marker visible to nobody but you (for planning). |

**Skill / mana** (lands with the skill system)

| Item | Cost | Effect |
|---|---|---|
| **Reorient stock** | 5g | One extra free reorient (no cooldown). Pawns only. |
| **Mana flask** | 4g | +mana for next skill cast. |
| **Skill swap** | 30g | Replace one piece's skill kit slot with another from your collection. |
| **Skill rush** | 18g | Your pieces' skill cooldowns reduced 50% for 10s. |

**Loadout** (applied at next respawn)

| Item | Cost | Effect |
|---|---|---|
| **Extra pawn slot** | 30g | +1 pawn at spawn. Cap +4. |
| **Promote token** | 40g | One pawn spawns as a bishop instead. |
| **Royal banner** | 50g | King starts with +1 HP (when HP system lands). |
| **War horn** | 12g | First 20s after each respawn, your king is shielded. |
| **Spawn beacon** | 25g | Place a beacon. Next respawn lands near it (within ZONE_SIZE). |

**Meta / strategic**

| Item | Cost | Effect |
|---|---|---|
| **Time bend** | 22g | Pause your pieces' cooldown clocks for 5s (act as if every piece is ready). |
| **Recall army** | 35g | All your alive pieces return to spawn formation. Lose any positional advantage, gain regroup. |
| **Truce flag** | 30g | No enemy can capture any of your pieces for 8s. King may still be checked. One-time per match. |
| **Bait pawn** | 8g | Spawn a fake pawn worth 9g of "salvage" to attackers — but on capture it explodes for 1 dmg to nearby enemies. |

**Cosmetic / social**

| Item | Cost | Effect |
|---|---|---|
| **Skin pack** | 20g | Alternate glyph/sprite set. |
| **Glow trail** | 15g | Pieces leave a fading trail in army color. |
| **Battle cry** | 5g | Short text shown above piece on next kill. |
| **Death taunt** | 8g | Custom one-liner shown on enemies' screens when they kill you. |
| **Victory dance** | 12g | Brief animation when your king captures. |

**Unlocks**

| Item | Cost | Effect |
|---|---|---|
| **Spawn-mode: custom layout** | 100g | Unlocks the custom spawn-layout designer (paid tier path). |
| **Custom mob builder access** | 250g | Unlocks the custom-piece designer. Each designed piece still costs roster points + per-build gold. |

### Cap rules

To keep stakes real:
- Max 5 active consumables per piece (shields stack but cap).
- Loadout items cap so a wealthy player can't enter with a 24-piece super-army (cap +4 pawns + 1 promote token).
- All effects are server-validated; client UI shows possibilities, server enforces.

### Custom mobs (paid)

Same builder described in **Planned — paid tier**. Purchasing the unlock
(or paying real money) opens the builder; designed pieces save to a personal
registry and may be selected during spawn loadout. Server validates every
custom piece against caps (max-attack-squares, max-HP, max-skills, total
points budget per army) so customs cannot pay-to-win.

### Wire / persistence sketch

```ts
interface Inventory {
  teleportScrolls: number;
  shieldCharges: Record<PieceId, number>; // per-piece stack
  cooldownResets: number;
  reorientStock: number;
  extraPawnSlots: number;
  skinPackId: string | null;
  customPieces: PieceDef[];
}

type ClientMessage =
  | { t: "shopBuy"; itemId: string; quantity: number; target?: PieceId }
  | { t: "useTeleport"; pieceId: PieceId; toX: number; toY: number }
  | { t: "useCooldownReset"; pieceId: PieceId };
```

Inventory persists in `stats.json`. Items resolve server-side; client just
shows the UI and sends intents.

### Implementation order

1. Gold per capture + persistence. HUD shows gold.
2. Shop overlay (replace plain respawn countdown).
3. Teleport scroll (simplest consumable). Server validates owner + range +
   inventory.
4. Shield charge, cooldown reset, reorient stock.
5. Extra pawn slots in spawn placement.
6. Skins (cosmetic).
7. Custom mob builder + per-army points budget.

## Planned — free

- Accounts (replace localStorage-only name) so stats are tied to identity.
- Variant piece sets (extra free registry entries: amazon, archbishop, dragon…).
- Persistent terrain (rubble, healing tiles) — stored in world, also indexed by zone.
- Spectator mode (join without spawning an army, free camera).
- Zone hand-off across processes (the actual MMO sharding move).
