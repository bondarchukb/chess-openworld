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

import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { PieceRegistry, STANDARD_PIECES, legalMovesPlaneFiltered, type Occupant } from "@chess-openworld/engine";
import { ARENA, WORLD, PIECE_SATS } from "@chess-openworld/protocol";
import type { Piece, PieceId, SelfInfo } from "@chess-openworld/protocol";
import { Connection } from "./net.js";
import { CELL, TILE_DEFS, tileColor, tileTypeAt, worldToScreen } from "./iso.js";

const PIECE_SVG: Record<string, string> = {
  king: "/pieces/wK.svg",
  queen: "/pieces/wQ.svg",
  rook: "/pieces/wR.svg",
  bishop: "/pieces/wB.svg",
  knight: "/pieces/wN.svg",
  pawn: "/pieces/wP.svg",
};
const pieceTextures: Record<string, Texture> = {};
async function preloadPieceTextures(): Promise<void> {
  for (const [type, path] of Object.entries(PIECE_SVG)) {
    pieceTextures[type] = await Assets.load(path);
  }
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
const wsProto = location.protocol === "https:" ? "wss" : "ws";
// Always proxy through the page's host (/ws). Vite dev forwards it to :8080;
// cloudflared/ngrok tunnels forward WebSocket upgrades transparently.
const wsUrl = envUrl ?? `${wsProto}://${location.host}/ws`;

const nameEl = document.getElementById("hud-name")!;
const statsEl = document.getElementById("hud-stats")!;
const hintEl = document.getElementById("hud-hint")!;
const connDot = document.getElementById("conn-dot")!;
const helpBtn = document.getElementById("help-btn") as HTMLButtonElement;
const helpOverlay = document.getElementById("help-overlay") as HTMLDivElement;
const helpClose = document.getElementById("help-close") as HTMLButtonElement;
const entryEl = document.getElementById("entry") as HTMLDivElement;
const entryNameEl = document.getElementById("entry-name") as HTMLInputElement;
const entryJoinEl = document.getElementById("entry-join") as HTMLButtonElement;
const skillbarEl = document.getElementById("skillbar") as HTMLDivElement;
const itembarEl = document.getElementById("itembar") as HTMLDivElement;
const tileinfoEl = document.getElementById("tileinfo") as HTMLDivElement;
const actionbarEl = document.getElementById("actionbar") as HTMLDivElement;
const deadEl = document.getElementById("dead-overlay") as HTMLDivElement;
const deadReasonEl = document.getElementById("dead-reason")!;
const deadEloEl = document.getElementById("dead-elo")!;
const deadCountdownEl = document.getElementById("dead-countdown")!;

const { name, spawnMode } = await chooseName();
localStorage.setItem("chess-mmo:name", name);
localStorage.setItem("chess-mmo:spawnMode", spawnMode);

const asSpectator = spawnMode === "spectator";
const gameMode: "open" | "domination" = spawnMode === "domination" ? "domination" : "open";
const actualSpawnMode: "classical" | "blob" =
  spawnMode === "blob" ? "blob" : "classical";
const conn = new Connection(wsUrl, name, actualSpawnMode, asSpectator, gameMode);
conn.onStatus = (t) => {
  // Map server status text to dot color. No more text noise in HUD.
  let color = "#888";
  if (t.startsWith("in world") || t === "respawned") color = "#88ee66";
  else if (t.startsWith("connecting") || t.includes("joining")) color = "#ffd86b";
  else if (t.includes("disconnect") || t.includes("error") || t === "dead") color = "#ff5577";
  connDot.style.background = color;
  connDot.title = t;
};

// Help modal toggling.
function toggleHelp(show?: boolean): void {
  const visible = helpOverlay.style.display === "flex";
  const next = show ?? !visible;
  helpOverlay.style.display = next ? "flex" : "none";
}
helpBtn.addEventListener("click", () => toggleHelp());
helpClose.addEventListener("click", () => toggleHelp(false));
helpOverlay.addEventListener("click", (e) => { if (e.target === helpOverlay) toggleHelp(false); });

type EntryMode = "classical" | "blob" | "domination" | "spectator";

async function chooseName(): Promise<{ name: string; spawnMode: EntryMode }> {
  const stored = localStorage.getItem("chess-mmo:name")?.trim();
  const storedMode = localStorage.getItem("chess-mmo:spawnMode") as EntryMode | null;
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
      const raw = modeEl?.value;
      const mode: EntryMode =
        raw === "blob" || raw === "spectator" || raw === "domination" ? raw : "classical";
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
await app.init({ background: "#1c1126", resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);
await preloadPieceTextures();

const scene = new Container();
const groundLayer = new Graphics();
const overlayLayer = new Container();
const pieceLayer = new Container();
const cooldownLayer = new Graphics();
const fxLayer = new Container();
scene.addChild(groundLayer, overlayLayer, pieceLayer, cooldownLayer, fxLayer);
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
  refreshWallet();
};
conn.onDead = (info) => {
  selectedPiece = null;
  legalTargets = new Set();
  deadEl.style.display = "flex";
  deadReasonEl.textContent = `${info.reason} by ${info.killerName} (ELO ${info.killerElo})`;
  const eloSign = info.eloDelta >= 0 ? "+" : "";
  const satsSign = info.satsDelta >= 0 ? "+" : "";
  const eloColor = info.eloDelta < 0 ? "#ff5577" : "#88ee66";
  const satsColor = info.satsDelta < 0 ? "#ff5577" : "#88ee66";
  deadEloEl.innerHTML =
    `ELO <b style="color:${eloColor}">${info.newStats.elo} (${eloSign}${info.eloDelta})</b>` +
    ` · ⚡<b style="color:${satsColor}">${formatSats(info.newStats.sats)} sats (${satsSign}${formatSats(info.satsDelta)})</b>`;
  conn.onStatus("dead");
};
conn.onRespawned = () => {
  deadEl.style.display = "none";
  conn.onStatus("respawned");
};
conn.onDominationWin = (info) => {
  showDominationBanner(info.winnerName, info.satsJackpot);
};

// ---- wallet panel (Lightning deposit / withdraw) ---------------------------

const wallet = document.createElement("div");
wallet.id = "wallet";
wallet.style.cssText =
  "position:fixed;right:12px;bottom:12px;width:260px;background:rgba(12,14,22,.92);" +
  "border:1px solid #2a3350;border-radius:10px;padding:12px;color:#cdd6f4;font:12px/1.4 system-ui;z-index:50;";
wallet.innerHTML =
  `<div style="font-weight:700;margin-bottom:6px">⚡ Wallet</div>` +
  `<div>Balance: <b id="w-bal">—</b> sats</div>` +
  `<div style="display:flex;gap:6px;margin-top:8px">` +
  `<button id="w-topup" style="flex:1">Top Up</button>` +
  `<button id="w-cashout" style="flex:1">Cash Out</button></div>` +
  `<div id="w-invoice" style="margin-top:8px;display:none">` +
  `<div id="w-inv-status" style="color:#f9e2af">Invoice — pay to deposit:</div>` +
  `<textarea id="w-inv-text" readonly style="width:100%;height:54px;margin-top:4px;font-size:10px;` +
  `background:#0b0e16;color:#94e2d5;border:1px solid #2a3350;border-radius:6px"></textarea></div>` +
  `<div id="w-msg" style="margin-top:6px;color:#a6adc8"></div>`;
document.body.appendChild(wallet);

const wBal = document.getElementById("w-bal")!;
const wInvoice = document.getElementById("w-invoice") as HTMLDivElement;
const wInvText = document.getElementById("w-inv-text") as HTMLTextAreaElement;
const wInvStatus = document.getElementById("w-inv-status")!;
const wMsg = document.getElementById("w-msg")!;

function refreshWallet(): void {
  wBal.textContent = conn.stats ? formatSats(conn.stats.sats) : "—";
}

document.getElementById("w-topup")!.addEventListener("click", () => {
  const v = prompt("Top up how many sats?", "1000");
  const sats = Number(v);
  if (!Number.isFinite(sats) || sats < 1) return;
  conn.requestDeposit(sats);
  wMsg.textContent = "Creating invoice…";
});
document.getElementById("w-cashout")!.addEventListener("click", () => {
  const addr = prompt("Cash out to Lightning address (name@domain):", "");
  if (!addr) return;
  const v = prompt("How many sats?", "500");
  const sats = Number(v);
  if (!Number.isFinite(sats) || sats < 1) return;
  conn.requestWithdraw(addr, sats);
  wMsg.textContent = "Sending payout…";
});

conn.onInvoice = (inv) => {
  wInvoice.style.display = "block";
  wInvStatus.textContent = `Pay ${formatSats(inv.sats)} sats to deposit:`;
  wInvText.value = inv.bolt11;
  wInvText.select();
  wMsg.textContent = "Waiting for payment…";
};
conn.onDepositCredited = (d) => {
  wInvoice.style.display = "none";
  wMsg.textContent = `Deposited ${formatSats(d.sats)} sats ✓`;
  refreshWallet();
};
conn.onWithdrawResult = (r) => {
  wMsg.textContent = r.ok ? `Cashed out ${formatSats(r.sats)} sats ✓` : `Cash out failed: ${r.reason ?? "?"}`;
  refreshWallet();
};
conn.onBalance = () => refreshWallet();
// In-page offer prompt — NOT confirm(), which browsers suppress in background tabs.
const offerBox = document.createElement("div");
offerBox.id = "offerbox";
offerBox.style.cssText =
  "position:fixed;left:50%;top:18%;transform:translateX(-50%);min-width:300px;display:none;" +
  "background:rgba(16,18,28,.97);border:2px solid #f9e2af;border-radius:12px;padding:16px;" +
  "color:#cdd6f4;font:14px/1.5 system-ui;z-index:200;box-shadow:0 8px 32px rgba(0,0,0,.5);text-align:center;";
document.body.appendChild(offerBox);

conn.onOfferReceived = (o) => {
  offerBox.innerHTML =
    `<div style="margin-bottom:10px"><b>${o.fromName}</b> offers <b style="color:#f9e2af">${formatSats(o.price)} sats</b> ` +
    `for your <b>${o.pieceType}</b>.<br>It will defect to them.</div>` +
    `<div style="display:flex;gap:8px;justify-content:center">` +
    `<button id="offer-yes" style="padding:6px 18px;background:#88ee66;color:#11151f;border:0;border-radius:6px;font-weight:700;cursor:pointer">Sell</button>` +
    `<button id="offer-no" style="padding:6px 18px;background:#ff5577;color:#fff;border:0;border-radius:6px;font-weight:700;cursor:pointer">Decline</button></div>`;
  offerBox.style.display = "block";
  const close = (accept: boolean) => { offerBox.style.display = "none"; conn.respondOffer(o.offerId, accept); };
  document.getElementById("offer-yes")!.onclick = () => close(true);
  document.getElementById("offer-no")!.onclick = () => close(false);
};
conn.onOfferResolved = (r) => {
  wMsg.textContent = r.ok ? "Offer accepted — piece is yours ✓" : `Offer ${r.reason ?? "declined"}`;
  refreshWallet();
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
    if (helpOverlay.style.display === "flex") {
      toggleHelp(false);
    } else {
      selectedPiece = null;
      legalTargets = new Set();
    }
  }
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
    toggleHelp();
  }
  if (e.key === "g" || e.key === "G") {
    const target = nearestEnemySpawn();
    if (target) {
      camera.cx = target.spawnX;
      camera.cy = target.spawnY;
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
  } else if (clickedPiece && clickedPiece.type !== "king") {
    // Enemy piece — make a buy offer; the owner must accept.
    const suggested = PIECE_SATS[clickedPiece.type] ?? 100;
    const v = prompt(`Offer how many sats for enemy ${clickedPiece.type}? (owner must accept)`, String(suggested));
    if (v === null) return;
    const price = Number(v);
    if (!Number.isFinite(price) || price < 0) return;
    conn.buyOffer(clickedPiece.id, price);
    wMsg.textContent = `Offer sent (${formatSats(price)} sats) — waiting for owner…`;
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
    hintEl.textContent = `on cooldown ${((piece.readyAt - conn.serverNow()) / 1000).toFixed(1)}s`;
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
        // Tile fill + subtle darker border for definition.
        groundLayer
          .rect(sx - CELL / 2, sy - CELL / 2, CELL, CELL)
          .fill({ color: tileColor(x, y) })
          .stroke({ color: 0x000000, alpha: 0.18, width: 1 });
      }
    }
  }

  // Overlay: legal-move highlights, selection ring, pawn facing arrows.
  overlayLayer.removeChildren();
  // Arena boundary first so it sits behind everything else.
  drawArenaOverlay();
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
    // Tween toward target instead of teleporting. Lerp factor tuned so a
    // 1-tile move takes ~150 ms at 60 fps.
    if (node.position.x === 0 && node.position.y === 0) {
      // First appearance: snap to target so we don't fly in from origin.
      node.position.set(sx, sy);
    } else {
      node.position.x += (sx - node.position.x) * 0.35;
      node.position.y += (sy - node.position.y) * 0.35;
    }
    // Fade piece while cooling down; full opacity when ready.
    const now = conn.serverNow();
    const remaining = piece.readyAt - now;
    if (remaining > 0) {
      const frac = Math.min(1, remaining / WORLD.pieceCooldownMs);
      node.alpha = 0.45 + 0.55 * (1 - frac);
    } else {
      node.alpha = 1;
    }
    used.add(key);
  }
  for (const [key, node] of pool) {
    if (!used.has(key)) {
      // Spawn a capture/leave flash at the piece's last known position.
      spawnCaptureFlash(node.position.x, node.position.y);
      node.destroy({ children: true });
      pool.delete(key);
    }
  }
  // Tick the active capture flashes.
  tickCaptureFlashes(app.ticker.deltaMS);

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
      text: `${a.name} · ${eloTxt} · ⚡${formatSats(a.sats)} · ${dist}`,
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

  nameEl.textContent = conn.self.name;
  if (conn.self.spectator) {
    statsEl.textContent = `spectator · ${enemyCount} armies online`;
  } else if (s) {
    statsEl.innerHTML =
      `ELO ${s.elo} · <span style="color:#ffd86b">⚡${formatSats(s.sats)} sats</span> · ` +
      `W ${s.wins}/L ${s.losses} · ${alive} pieces · ${enemyCount} enemies online`;
  } else {
    statsEl.textContent = `${alive} pieces · ${enemyCount} enemies online`;
  }

  // Contextual bottom hint.
  let hint = "click a piece to act";
  if (selectedPiece !== null) {
    const p = conn.pieces.get(selectedPiece);
    if (p?.type === "pawn") hint = "click target · 1/2/3/4 reorient · Esc";
    else hint = "click target · Esc to deselect";
  } else if (enemyCount > 0) {
    hint = "click a piece to act · G to find enemy · ? for help";
  } else {
    hint = "no enemies online — pan with WASD";
  }
  hintEl.textContent = hint;

  renderSkillbar();

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
  const armyColor = parseColor(piece.color);

  // Drop shadow at the piece's "feet" so it pops off the tile.
  const shadow = new Graphics()
    .ellipse(0, CELL * 0.30, CELL * 0.36, CELL * 0.08)
    .fill({ color: 0x000000, alpha: 0.45 });
  c.addChild(shadow);

  // Solid army-colour coaster behind the piece. Opaque centre + glow halo.
  const halo = new Graphics()
    .circle(0, 0, CELL * 0.5)
    .fill({ color: armyColor, alpha: 0.18 });
  c.addChild(halo);
  const disc = new Graphics()
    .circle(0, 0, CELL * 0.36)
    .fill({ color: armyColor, alpha: 0.9 })
    .stroke({ color: 0x000000, alpha: 0.85, width: 2 });
  c.addChild(disc);

  // Royal halo for the king.
  if (piece.type === "king") {
    const crown = new Graphics()
      .circle(0, 0, CELL * 0.52)
      .stroke({ color: 0xffd86b, width: 3, alpha: 0.95 });
    c.addChild(crown);
  }

  // Vector silhouette. We render two passes for crispness: a black outline
  // pass (tint black, slightly larger) and a white-tinted top pass for the
  // body. The SVG already has a thin outline, but layering this way lets
  // the piece read on any tile colour.
  const tex = pieceTextures[piece.type];
  if (tex) {
    const outline = new Sprite(tex);
    outline.anchor.set(0.5);
    outline.width = CELL * 0.92;
    outline.height = CELL * 0.92;
    outline.tint = 0x000000;
    c.addChild(outline);

    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    sprite.width = CELL * 0.86;
    sprite.height = CELL * 0.86;
    // Use white for the body so the SVG's own outline does the colour work,
    // and the piece looks like a porcelain figure on a coloured base.
    sprite.tint = 0xffffff;
    c.addChild(sprite);
  } else {
    const t = new Text({
      text: "?",
      style: { fontFamily: "serif", fontSize: CELL * 0.6, fill: 0xffffff },
    });
    t.anchor.set(0.5);
    c.addChild(t);
  }

  // Own-team ring: bright white outer ring, slightly outside the disc.
  if (isMine) {
    const ring = new Graphics()
      .circle(0, 0, CELL * 0.44)
      .stroke({ color: 0xffffff, width: 2, alpha: 0.95 });
    c.addChild(ring);
  }
  return c;
}

function parseColor(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

/** Format a sat count compactly: 12,345 / 1.2k / 3.4M */
function formatSats(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

interface Flash {
  x: number;
  y: number;
  age: number; // ms
  g: Graphics;
}
const flashes: Flash[] = [];
const FLASH_LIFETIME = 420;

/**
 * Skill kit per piece type. Most are placeholders that will light up as the
 * skill system in SPEC.md ships. Reorient is the only fully working skill;
 * the rest show as "locked" tooltips so the panel still feels alive.
 */
interface SkillSlot {
  id: string;
  icon: string;
  name: string;
  key: string;
  live: boolean;
}
const SKILL_KIT: Record<string, SkillSlot[]> = {
  pawn: [
    { id: "reorient", icon: "↻", name: "Reorient (1/2/3/4)", key: "↻", live: true },
    { id: "lock-shield", icon: "🛡", name: "Lock Shield (coming)", key: "Q", live: false },
  ],
  knight: [
    { id: "charge", icon: "⚡", name: "Cavalry Charge (coming)", key: "Q", live: false },
    { id: "hoof", icon: "💢", name: "Hoofquake (coming)", key: "W", live: false },
  ],
  bishop: [
    { id: "beam", icon: "✦", name: "Beam (coming)", key: "Q", live: false },
    { id: "bless", icon: "✨", name: "Bless (coming)", key: "W", live: false },
  ],
  rook: [
    { id: "quake", icon: "💥", name: "Quake (coming)", key: "Q", live: false },
    { id: "wall", icon: "🧱", name: "Wall (coming)", key: "W", live: false },
  ],
  queen: [
    { id: "teleport", icon: "✧", name: "Swap-Teleport (coming)", key: "Q", live: false },
    { id: "storm", icon: "⛈", name: "Storm (coming)", key: "W", live: false },
  ],
  king: [
    { id: "rally", icon: "📢", name: "Rally (coming)", key: "Q", live: false },
    { id: "stand", icon: "🛡", name: "Last Stand (coming)", key: "W", live: false },
  ],
};

interface MockItem { id: string; icon: string; name: string; key: string; count: number }
const MOCK_ITEMS: MockItem[] = [
  { id: "teleport",   icon: "✦", name: "Teleport scroll (coming)", key: "T", count: 0 },
  { id: "shield",     icon: "🛡", name: "Shield charge (coming)",   key: "H", count: 0 },
  { id: "cd-reset",   icon: "⟳", name: "Cooldown reset (coming)",   key: "R", count: 0 },
  { id: "spyglass",   icon: "🔭", name: "Spyglass (coming)",        key: "Y", count: 0 },
];

function renderSkillbar(): void {
  if (selectedPiece === null) {
    actionbarEl.classList.remove("visible");
    return;
  }
  const piece = conn.pieces.get(selectedPiece);
  if (!piece || piece.owner !== conn.self?.armyId) {
    actionbarEl.classList.remove("visible");
    return;
  }
  const kit = SKILL_KIT[piece.type] ?? [];
  const skillsHtml = kit
    .map((s) => {
      const cls = "slot skill" + (s.live ? "" : " locked");
      return `<div class="${cls}" title="${s.name}">
        <span class="name">${s.name}</span>
        <span>${s.icon}</span>
        <span class="key">${s.key}</span>
      </div>`;
    })
    .join("");
  const itemsHtml = MOCK_ITEMS
    .map((it) => {
      const cls = "slot item locked";
      return `<div class="${cls}" title="${it.name}">
        <span class="name">${it.name}</span>
        <span>${it.icon}</span>
        <span class="key">${it.key}</span>
      </div>`;
    })
    .join("");
  if (skillsHtml !== skillbarEl.innerHTML) skillbarEl.innerHTML = skillsHtml;
  if (itemsHtml !== itembarEl.innerHTML) itembarEl.innerHTML = itemsHtml;

  // Tile under the selected piece + mock effect string.
  const t = tileTypeAt(piece.x, piece.y);
  const def = TILE_DEFS[t];
  tileinfoEl.innerHTML = `Standing on <b>${def.label}</b> — ${def.effect}`;
  actionbarEl.classList.add("visible");
}

function showDominationBanner(winnerName: string, jackpot: number): void {
  let el = document.getElementById("dom-banner") as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = "dom-banner";
    el.style.cssText = `position: fixed; top: 25%; left: 50%; transform: translateX(-50%);
      z-index: 70; background: rgba(31,23,56,.95); color: #ffd86b; padding: 26px 40px;
      border-radius: 14px; border: 3px solid #ffd86b; font-size: 22px; font-weight: 800;
      text-align: center; box-shadow: 0 12px 50px #000;`;
    document.body.appendChild(el);
  }
  el.innerHTML = `⚔ DOMINATION ⚔<br/>` +
    `<span style="color:#fff; font-size:18px;">${winnerName} wins the arena</span><br/>` +
    `<span style="color:#88ee66; font-size:16px;">+⚡${formatSats(jackpot)} sats jackpot</span>`;
  el.style.display = "block";
  setTimeout(() => { if (el) el.style.display = "none"; }, 6000);
}

function drawArenaOverlay(): void {
  if (!conn.self) return;
  // Show the arena only when at least one player is in domination mode.
  const anyDom = conn.roster.some((a) => a.gameMode === "domination");
  if (!anyDom) return;
  const { centerX, centerY, halfSize } = ARENA;
  const topLeft = worldToScreen(centerX - halfSize, centerY - halfSize);
  const w = (halfSize * 2 + 1) * CELL;
  const g = new Graphics()
    .rect(topLeft.sx - CELL / 2, topLeft.sy - CELL / 2, w, w)
    .stroke({ color: 0xffd86b, width: 4, alpha: 0.85 });
  overlayLayer.addChild(g);
  // Soft gold tint inside.
  const fill = new Graphics()
    .rect(topLeft.sx - CELL / 2, topLeft.sy - CELL / 2, w, w)
    .fill({ color: 0xffd86b, alpha: 0.05 });
  overlayLayer.addChildAt(fill, 0);
}

function spawnCaptureFlash(x: number, y: number): void {
  const g = new Graphics();
  fxLayer.addChild(g);
  flashes.push({ x, y, age: 0, g });
}

function tickCaptureFlashes(deltaMs: number): void {
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]!;
    f.age += deltaMs;
    const t = f.age / FLASH_LIFETIME;
    if (t >= 1) {
      f.g.destroy();
      flashes.splice(i, 1);
      continue;
    }
    f.g.clear();
    const radius = CELL * (0.2 + t * 0.7);
    const alpha = 1 - t;
    f.g
      .circle(f.x, f.y, radius)
      .stroke({ color: 0xffe066, width: 3, alpha });
    f.g
      .circle(f.x, f.y, radius * 0.6)
      .stroke({ color: 0xff5577, width: 2, alpha: alpha * 0.6 });
  }
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
