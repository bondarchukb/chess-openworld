/**
 * Client entrypoint: top-down open-plane chess.
 *
 * The client is dumb: sends pieceMove intents, draws whatever pieces the
 * server says are nearby. Camera is free — pan with WASD/arrows/drag, zoom
 * with wheel, press C to recenter on your army. Click own piece to select,
 * click a highlighted square to move (or click elsewhere to deselect).
 *
 * Legal-move highlighting runs locally via the same engine the server uses
 * (server still validates). Cooldown shows as a shrinking ring under each
 * piece.
 */

import { Application, Container, Graphics, Text } from "pixi.js";
import { PieceRegistry, STANDARD_PIECES, legalMovesPlaneFiltered, type Occupant } from "@chess-openworld/engine";
import { WORLD } from "@chess-openworld/protocol";
import type { Piece, PieceId, SelfInfo } from "@chess-openworld/protocol";
import { Connection } from "./net.js";
import { CELL, pieceGlyph, tileColor, worldToScreen } from "./iso.js";

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
const wsProto = location.protocol === "https:" ? "wss" : "ws";
// Always proxy through the page's host (/ws). Vite dev forwards it to :8080;
// cloudflared/ngrok tunnels forward WebSocket upgrades transparently.
const wsUrl = envUrl ?? `${wsProto}://${location.host}/ws`;

const statusEl = document.getElementById("status")!;
const infoEl = document.getElementById("board")!;
const entryEl = document.getElementById("entry") as HTMLDivElement;
const entryNameEl = document.getElementById("entry-name") as HTMLInputElement;
const entryJoinEl = document.getElementById("entry-join") as HTMLButtonElement;
const changeNameEl = document.getElementById("change-name") as HTMLButtonElement;
const deadEl = document.getElementById("dead-overlay") as HTMLDivElement;
const deadReasonEl = document.getElementById("dead-reason")!;
const deadEloEl = document.getElementById("dead-elo")!;
const deadCountdownEl = document.getElementById("dead-countdown")!;

const { name, spawnMode } = await chooseName();
localStorage.setItem("chess-mmo:name", name);
localStorage.setItem("chess-mmo:spawnMode", spawnMode);

const conn = new Connection(wsUrl, name, spawnMode);
conn.onStatus = (t) => (statusEl.textContent = t);
changeNameEl.style.display = "block";
changeNameEl.addEventListener("click", () => {
  // Disconnect + reload is simpler than tearing down all Pixi state.
  localStorage.removeItem("chess-mmo:name");
  location.reload();
});

async function chooseName(): Promise<{ name: string; spawnMode: "classical" | "blob" }> {
  const stored = localStorage.getItem("chess-mmo:name")?.trim();
  const storedMode = localStorage.getItem("chess-mmo:spawnMode") as "classical" | "blob" | null;
  entryNameEl.value = stored ?? "";
  if (storedMode) {
    const radio = document.querySelector<HTMLInputElement>(`input[name="spawn-mode"][value="${storedMode}"]`);
    if (radio) radio.checked = true;
  }
  entryEl.style.display = "flex";
  entryNameEl.focus();
  return new Promise((resolve) => {
    const submit = () => {
      const v = entryNameEl.value.trim();
      if (!v) {
        entryNameEl.focus();
        return;
      }
      const modeEl = document.querySelector<HTMLInputElement>('input[name="spawn-mode"]:checked');
      const mode = (modeEl?.value === "blob" ? "blob" : "classical") as "classical" | "blob";
      entryEl.style.display = "none";
      resolve({ name: v, spawnMode: mode });
    };
    entryJoinEl.addEventListener("click", submit);
    entryNameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  });
}

const registry = new PieceRegistry(STANDARD_PIECES);

const app = new Application();
await app.init({ background: "#15102a", resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

const scene = new Container();
const groundLayer = new Graphics();
const overlayLayer = new Container();
const pieceLayer = new Container();
const cooldownLayer = new Graphics();
scene.addChild(groundLayer, overlayLayer, pieceLayer, cooldownLayer);
app.stage.addChild(scene);
/** Screen-space layer (not scaled by camera) for compass arrows etc. */
const uiLayer = new Container();
app.stage.addChild(uiLayer);

// ---- camera ----------------------------------------------------------------

const camera = { cx: 0, cy: 0, zoom: 1 };
let selectedPiece: PieceId | null = null;
let legalTargets: Set<string> = new Set();

conn.onWelcome = (you: SelfInfo) => {
  camera.cx = you.spawnX;
  camera.cy = you.spawnY;
  infoEl.textContent = `Army color ${you.color} — center on (${you.spawnX}, ${you.spawnY})`;
};
conn.onDead = (info) => {
  selectedPiece = null;
  legalTargets = new Set();
  deadEl.style.display = "flex";
  deadReasonEl.textContent = `${info.reason} by ${info.killerName} (ELO ${info.killerElo})`;
  const sign = info.eloDelta >= 0 ? "+" : "";
  deadEloEl.innerHTML = `your ELO: <b style="color:${info.eloDelta < 0 ? "#ff5577" : "#88ee66"}">${info.newStats.elo} (${sign}${info.eloDelta})</b>`;
  statusEl.textContent = `dead`;
};
conn.onRespawned = () => {
  deadEl.style.display = "none";
  statusEl.textContent = `respawned`;
};

// ---- keyboard --------------------------------------------------------------

const PAN_SPEED = 0.4; // tiles per frame at zoom=1
const heldKeys = new Set<string>();
const REORIENT_KEYS: Record<string, [number, number]> = {
  "1": [0, -1], // up
  "2": [1, 0],  // right
  "3": [0, 1],  // down
  "4": [-1, 0], // left
};

window.addEventListener("keydown", (e) => {
  heldKeys.add(e.key.toLowerCase());
  if (e.key === "c" || e.key === "C") {
    if (conn.self) {
      camera.cx = conn.self.spawnX;
      camera.cy = conn.self.spawnY;
    }
  }
  if (e.key === "Escape") {
    selectedPiece = null;
    legalTargets = new Set();
  }
  if (e.key === "g" || e.key === "G") {
    const target = nearestEnemySpawn();
    if (target) {
      camera.cx = target.spawnX;
      camera.cy = target.spawnY;
      statusEl.textContent = `jumped to ${target.name} at (${target.spawnX}, ${target.spawnY})`;
    }
  }
  // Reorient hotkeys (only for selected own pawn).
  const dir = REORIENT_KEYS[e.key];
  if (dir && selectedPiece !== null && conn.self) {
    const p = conn.pieces.get(selectedPiece);
    if (p && p.type === "pawn" && p.owner === conn.self.armyId) {
      conn.send({ t: "reorient", pieceId: p.id, dir });
      selectedPiece = null;
      legalTargets = new Set();
    }
  }
});
window.addEventListener("keyup", (e) => heldKeys.delete(e.key.toLowerCase()));

// ---- mouse: drag to pan, click to select/move, wheel to zoom ----------------

let dragging = false;
let lastPtr = { x: 0, y: 0 };
let dragMoved = 0;

app.canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragMoved = 0;
  lastPtr = { x: e.clientX, y: e.clientY };
  app.canvas.style.cursor = "grabbing";
});

window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dpx = e.clientX - lastPtr.x;
  const dpy = e.clientY - lastPtr.y;
  lastPtr = { x: e.clientX, y: e.clientY };
  dragMoved += Math.abs(dpx) + Math.abs(dpy);
  camera.cx -= dpx / (CELL * camera.zoom);
  camera.cy -= dpy / (CELL * camera.zoom);
});

window.addEventListener("pointerup", (e) => {
  dragging = false;
  app.canvas.style.cursor = "grab";
  if (dragMoved < 6) handleClick(e.clientX, e.clientY);
});

app.canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    camera.zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  },
  { passive: false }
);
app.canvas.style.cursor = "grab";

function pickTile(clientX: number, clientY: number): { x: number; y: number } {
  const sceneX = app.screen.width / 2 - camera.cx * CELL * camera.zoom;
  const sceneY = app.screen.height / 2 - camera.cy * CELL * camera.zoom;
  const wx = (clientX - sceneX) / (CELL * camera.zoom);
  const wy = (clientY - sceneY) / (CELL * camera.zoom);
  return { x: Math.round(wx), y: Math.round(wy) };
}

function handleClick(clientX: number, clientY: number): void {
  if (!conn.self) return;
  const { x, y } = pickTile(clientX, clientY);
  const clickedPiece = findPieceAt(x, y);

  if (selectedPiece !== null) {
    if (legalTargets.has(`${x},${y}`)) {
      conn.send({ t: "pieceMove", pieceId: selectedPiece, toX: x, toY: y });
      selectedPiece = null;
      legalTargets = new Set();
      return;
    }
    // Click on another own piece = switch selection; otherwise deselect.
    if (clickedPiece && clickedPiece.owner === conn.self.armyId) {
      selectAndComputeMoves(clickedPiece);
      return;
    }
    selectedPiece = null;
    legalTargets = new Set();
    return;
  }
  if (clickedPiece && clickedPiece.owner === conn.self.armyId) {
    selectAndComputeMoves(clickedPiece);
  }
}

function findPieceAt(x: number, y: number): Piece | null {
  for (const p of conn.pieces.values()) if (p.x === x && p.y === y) return p;
  return null;
}

function nearestEnemySpawn(): { name: string; color: string; spawnX: number; spawnY: number; elo: number } | null {
  if (!conn.self) return null;
  let best: { name: string; color: string; spawnX: number; spawnY: number; elo: number; d: number } | null = null;
  for (const a of conn.roster) {
    if (a.id === conn.self.armyId) continue;
    const d = Math.hypot(a.spawnX - camera.cx, a.spawnY - camera.cy);
    if (!best || d < best.d) best = { name: a.name, color: a.color, spawnX: a.spawnX, spawnY: a.spawnY, elo: a.elo, d };
  }
  return best;
}

function selectAndComputeMoves(piece: Piece): void {
  if (!conn.self) return;
  if (conn.serverNow() < piece.readyAt) {
    statusEl.textContent = `on cooldown ${((piece.readyAt - conn.serverNow()) / 1000).toFixed(1)}s`;
    selectedPiece = null;
    legalTargets = new Set();
    return;
  }
  selectedPiece = piece.id;
  const plane = {
    owner: piece.owner,
    type: piece.type,
    forward: piece.forward ?? undefined,
    hasMoved: piece.hasMoved,
    x: piece.x,
    y: piece.y,
  };
  const getOccupant = (x: number, y: number): Occupant => {
    const p = findPieceAt(x, y);
    if (!p) return null;
    return {
      owner: p.owner,
      type: p.type,
      forward: p.forward ?? undefined,
      hasMoved: p.hasMoved,
      x: p.x,
      y: p.y,
    };
  };
  const allPieces = function* () {
    for (const p of conn.pieces.values()) {
      yield {
        owner: p.owner, type: p.type, forward: p.forward ?? undefined, hasMoved: p.hasMoved, x: p.x, y: p.y,
      };
    }
  };
  const findKing = (owner: string) => {
    for (const p of conn.pieces.values()) {
      if (p.owner === owner && p.type === "king") return { x: p.x, y: p.y };
    }
    return null;
  };
  // Filtered = won't suggest moves that leave own king in check.
  // Approximate when attackers sit outside the local interest set; the server
  // still validates and will reject anything we miss.
  const moves = legalMovesPlaneFiltered(plane, registry, getOccupant, allPieces, findKing, WORLD.maxRideRange);
  legalTargets = new Set(moves.map((m) => `${m.x},${m.y}`));
}

// ---- focus throttling: tell server where camera looks ----------------------

let lastSentFocus = { x: NaN, y: NaN };
function maybeSendFocus(): void {
  const fx = Math.round(camera.cx);
  const fy = Math.round(camera.cy);
  if (fx !== lastSentFocus.x || fy !== lastSentFocus.y) {
    lastSentFocus = { x: fx, y: fy };
    conn.send({ t: "focus", x: fx, y: fy });
  }
}

// ---- render loop -----------------------------------------------------------

const pool = new Map<string, Container>();
let groundKey = "";

app.ticker.add((tk) => {
  applyHeldKeys(tk.deltaTime);

  scene.scale.set(camera.zoom);
  scene.position.set(
    app.screen.width / 2 - camera.cx * CELL * camera.zoom,
    app.screen.height / 2 - camera.cy * CELL * camera.zoom
  );

  // Ground tiles: rebuild only when the visible window changes.
  const halfW = app.screen.width / 2 / camera.zoom;
  const halfH = app.screen.height / 2 / camera.zoom;
  const radius = Math.ceil(Math.max(halfW, halfH) / CELL) + 2;
  const ccx = Math.round(camera.cx);
  const ccy = Math.round(camera.cy);
  const gkey = `${ccx},${ccy},${radius}`;
  if (gkey !== groundKey) {
    groundKey = gkey;
    groundLayer.clear();
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = ccx + dx;
        const y = ccy + dy;
        const { sx, sy } = worldToScreen(x, y);
        groundLayer
          .rect(sx - CELL / 2, sy - CELL / 2, CELL, CELL)
          .fill({ color: tileColor(x, y) });
      }
    }
  }

  // Overlay: legal-move highlights, selection ring, pawn facing arrows.
  overlayLayer.removeChildren();
  // Forward-direction arrow for every visible pawn (always shown).
  for (const piece of conn.pieces.values()) {
    if (piece.type !== "pawn" || !piece.forward) continue;
    const { sx, sy } = worldToScreen(piece.x, piece.y);
    overlayLayer.addChild(makeFacingArrow(sx, sy, piece.forward, 0xffffff, 0.7));
  }
  if (selectedPiece !== null) {
    const p = conn.pieces.get(selectedPiece);
    if (p) {
      const ring = new Graphics();
      const { sx, sy } = worldToScreen(p.x, p.y);
      ring
        .rect(sx - CELL / 2 + 2, sy - CELL / 2 + 2, CELL - 4, CELL - 4)
        .stroke({ color: 0xffe066, width: 3 });
      overlayLayer.addChild(ring);
      // Reorient hint: faint arrows in adjacent cells of own selected pawn.
      if (p.type === "pawn" && conn.self && p.owner === conn.self.armyId) {
        const dirs: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        const labels = ["1", "2", "3", "4"];
        dirs.forEach((d, i) => {
          const tx = p.x + d[0];
          const ty = p.y + d[1];
          const { sx: asx, sy: asy } = worldToScreen(tx, ty);
          overlayLayer.addChild(makeFacingArrow(asx, asy, d, 0xffd86b, 0.35));
          const lbl = new Text({
            text: labels[i]!,
            style: { fontSize: 12, fill: 0xffd86b, stroke: { color: 0x000000, width: 2 } },
          });
          lbl.anchor.set(0.5);
          lbl.position.set(asx + d[0] * CELL * 0.32, asy + d[1] * CELL * 0.32);
          overlayLayer.addChild(lbl);
        });
      }
    }
    for (const key of legalTargets) {
      const [tx, ty] = key.split(",").map(Number);
      const { sx, sy } = worldToScreen(tx!, ty!);
      const tgt = findPieceAt(tx!, ty!);
      const capture = tgt && conn.self && tgt.owner !== conn.self.armyId;
      const g = new Graphics();
      if (capture) {
        g.rect(sx - CELL / 2, sy - CELL / 2, CELL, CELL).stroke({ color: 0xff3333, width: 3 });
      } else {
        g.circle(sx, sy, CELL * 0.18).fill({ color: 0xffe066, alpha: 0.55 });
      }
      overlayLayer.addChild(g);
    }
  }

  // Pieces: reuse nodes by id; recreate only when type changes (rare).
  const used = new Set<string>();
  for (const piece of conn.pieces.values()) {
    const key = `p${piece.id}:${piece.type}:${piece.color}`;
    let node = pool.get(key);
    if (!node) {
      // Drop any stale node for this piece id with a different style.
      for (const k of pool.keys()) {
        if (k.startsWith(`p${piece.id}:`) && k !== key) {
          pool.get(k)?.destroy({ children: true });
          pool.delete(k);
        }
      }
      node = makePieceNode(piece, conn.self?.armyId ?? "");
      pieceLayer.addChild(node);
      pool.set(key, node);
    }
    const { sx, sy } = worldToScreen(piece.x, piece.y);
    node.position.set(sx, sy);
    // Fade piece while cooling down; full opacity when ready.
    const now = conn.serverNow();
    const remaining = piece.readyAt - now;
    if (remaining > 0) {
      const frac = Math.min(1, remaining / WORLD.pieceCooldownMs);
      node.alpha = 0.45 + 0.55 * (1 - frac); // 0.45 just after move → 1.0 when ready
    } else {
      node.alpha = 1;
    }
    used.add(key);
  }
  for (const [key, node] of pool) {
    if (!used.has(key)) {
      node.destroy({ children: true });
      pool.delete(key);
    }
  }

  // Cooldown bars: thin shrinking bar under each cooling piece.
  cooldownLayer.clear();
  const now = conn.serverNow();
  for (const piece of conn.pieces.values()) {
    const remaining = piece.readyAt - now;
    if (remaining <= 0) continue;
    const frac = Math.min(1, remaining / WORLD.pieceCooldownMs);
    const { sx, sy } = worldToScreen(piece.x, piece.y);
    const w = CELL * 0.7;
    const by = sy + CELL * 0.42;
    cooldownLayer.rect(sx - w / 2, by, w, 3).fill({ color: 0x000000, alpha: 0.35 });
    cooldownLayer.rect(sx - w / 2, by, w * (1 - frac), 3).fill({ color: 0xffd86b, alpha: 0.95 });
  }

  renderCompass();
  maybeSendFocus();
  renderHud();
});

function renderCompass(): void {
  uiLayer.removeChildren();
  if (!conn.self) return;
  // Red border + label when our army is in check.
  const me = conn.roster.find((a) => a.id === conn.self!.armyId);
  if (me?.inCheck) {
    const sw = app.screen.width;
    const sh = app.screen.height;
    const pulse = 0.55 + 0.25 * Math.sin(performance.now() / 180);
    const border = new Graphics()
      .rect(0, 0, sw, sh)
      .stroke({ color: 0xff3333, width: 10, alpha: pulse });
    uiLayer.addChild(border);
    const label = new Text({
      text: "CHECK",
      style: { fontFamily: "system-ui", fontSize: 36, fontWeight: "900", fill: 0xff3333,
        stroke: { color: 0x000000, width: 5 } },
    });
    label.anchor.set(0.5, 0);
    label.position.set(sw / 2, 14);
    label.alpha = pulse;
    uiLayer.addChild(label);
  }
  const sw = app.screen.width;
  const sh = app.screen.height;
  const cx = sw / 2;
  const cy = sh / 2;
  // Inset from edge by this many pixels so arrows sit visibly on-screen.
  const margin = 36;
  for (const a of conn.roster) {
    if (a.id === conn.self.armyId) continue;
    const dxW = a.spawnX - camera.cx;
    const dyW = a.spawnY - camera.cy;
    // Project to screen pixels.
    const dxS = dxW * CELL * camera.zoom;
    const dyS = dyW * CELL * camera.zoom;
    // If on-screen, skip arrow (player can see them).
    if (Math.abs(dxS) < sw / 2 - margin && Math.abs(dyS) < sh / 2 - margin) continue;
    // Clamp ray (cx,cy)+(dxS,dyS) to the inset rectangle.
    const halfW = sw / 2 - margin;
    const halfH = sh / 2 - margin;
    const scale = Math.min(halfW / Math.max(1, Math.abs(dxS)), halfH / Math.max(1, Math.abs(dyS)));
    const px = cx + dxS * scale;
    const py = cy + dyS * scale;
    const angle = Math.atan2(dyS, dxS);
    const g = new Graphics();
    g.poly([12, 0, -8, -7, -8, 7]).fill({ color: parseColor(a.color) }).stroke({ color: 0x000000, width: 2 });
    g.position.set(px, py);
    g.rotation = angle;
    uiLayer.addChild(g);
    const dist = Math.round(Math.hypot(dxW, dyW));
    const eloTxt = `ELO ${a.elo}${a.dead ? " · DEAD" : ""}`;
    const lbl = new Text({
      text: `${a.name} · ${eloTxt} · ${dist}`,
      style: { fontSize: 11, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
    });
    lbl.anchor.set(0.5, 1.4);
    lbl.position.set(px, py);
    uiLayer.addChild(lbl);
  }
}

function applyHeldKeys(deltaFrames: number): void {
  let dx = 0;
  let dy = 0;
  if (heldKeys.has("w") || heldKeys.has("arrowup")) dy -= 1;
  if (heldKeys.has("s") || heldKeys.has("arrowdown")) dy += 1;
  if (heldKeys.has("a") || heldKeys.has("arrowleft")) dx -= 1;
  if (heldKeys.has("d") || heldKeys.has("arrowright")) dx += 1;
  if (dx || dy) {
    const speed = PAN_SPEED * deltaFrames / camera.zoom;
    camera.cx += dx * speed;
    camera.cy += dy * speed;
  }
}

function renderHud(): void {
  if (!conn.self) return;
  let alive = 0;
  for (const p of conn.pieces.values()) if (p.owner === conn.self.armyId) alive++;
  const enemyCount = conn.roster.filter((a) => a.id !== conn.self!.armyId).length;
  const s = conn.stats;
  const statsStr = s ? `ELO ${s.elo} · W ${s.wins}/L ${s.losses}` : "";
  const nearest = nearestEnemySpawn();
  const nearestStr = nearest
    ? ` · nearest ${nearest.name} (ELO ${nearest.elo ?? "?"}) at (${nearest.spawnX}, ${nearest.spawnY}) — G to jump`
    : " · no enemies online";
  infoEl.textContent =
    `${conn.self.name} · ${statsStr} · pieces ${alive} · ` +
    `cam (${Math.round(camera.cx)}, ${Math.round(camera.cy)}) · ${enemyCount} enemies${nearestStr}`;

  // Dead-countdown updater (cheap).
  if (conn.dead) {
    const remaining = Math.max(0, conn.dead.respawnAt - conn.serverNow());
    deadCountdownEl.textContent = `respawn in ${(remaining / 1000).toFixed(1)}s`;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function makePieceNode(piece: Piece, myArmyId: string): Container {
  const c = new Container();
  const isMine = piece.owner === myArmyId;
  // Filled disc behind the glyph carries the army color.
  const disc = new Graphics()
    .circle(0, 0, CELL * 0.38)
    .fill({ color: parseColor(piece.color) })
    .stroke({ color: isMine ? 0xffffff : 0x000000, width: isMine ? 3 : 2, alpha: isMine ? 0.9 : 0.6 });
  c.addChild(disc);
  // Royalty highlight.
  if (piece.type === "king") {
    const crown = new Graphics()
      .circle(0, 0, CELL * 0.45)
      .stroke({ color: 0xffd86b, width: 2, alpha: 0.9 });
    c.addChild(crown);
  }
  // Glyph (black or white depending on color brightness for legibility).
  const text = new Text({
    text: pieceGlyph(piece.type),
    style: {
      fontFamily: "serif",
      fontSize: CELL * 0.7,
      fill: glyphFill(piece.color),
      stroke: { color: 0x000000, width: 2 },
    },
  });
  text.anchor.set(0.5, 0.55);
  c.addChild(text);
  return c;
}

function parseColor(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

function glyphFill(bgHex: string): number {
  const n = parseColor(bgHex);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  return luma > 140 ? 0x111111 : 0xffffff;
}

/** Small chevron at the edge of a cell pointing in dir. */
function makeFacingArrow(cx: number, cy: number, dir: [number, number], color: number, alpha: number): Graphics {
  const g = new Graphics();
  const tipDist = CELL * 0.42;
  const tipX = cx + dir[0] * tipDist;
  const tipY = cy + dir[1] * tipDist;
  // Perpendicular vector for the chevron base.
  const px = -dir[1];
  const py = dir[0];
  const baseDist = CELL * 0.28;
  const halfW = CELL * 0.12;
  const baseCx = cx + dir[0] * baseDist;
  const baseCy = cy + dir[1] * baseDist;
  g.poly([
    tipX, tipY,
    baseCx + px * halfW, baseCy + py * halfW,
    baseCx - px * halfW, baseCy - py * halfW,
  ]).fill({ color, alpha });
  return g;
}
