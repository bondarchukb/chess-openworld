/**
 * The networking + simulation layer.
 *
 * Per tick, for every connected player we:
 *   1. compute their interest set (the ~9 zones around them),
 *   2. diff it against what they last knew, and
 *   3. send only the *changes* (enter / leave / move).
 *
 * That diff is "interest management" — the single technique that lets an MMO
 * show thousands of entities without sending the whole world to everyone. It
 * is the reason we don't just broadcast global state.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  WORLD,
  interestZones,
  skinById,
  zoneOf,
  type ClientMessage,
  type Entity,
  type EntityId,
  type ServerMessage,
} from "@chess-openworld/protocol";
import { World } from "./world.js";
import { MockLightningProvider, type LightningProvider } from "./payments.js";

interface Session {
  playerId: EntityId;
  socket: WebSocket;
  name: string;
  /** What this client currently believes is in its interest set. */
  known: Map<EntityId, { x: number; y: number }>;
  lastBoardVersion: number;
  /** Where the player's camera is looking, if panned away from the avatar.
   * Interest is streamed around the avatar AND this point. */
  focus: { x: number; y: number } | null;
  /** Latest requested step; applied at most once per tick (authoritative
   * speed limit — prevents clients moving many tiles by spamming messages). */
  pendingMove: { dx: number; dy: number } | null;
  /** Stable identity for cosmetic purchases across sessions. */
  accountId: string;
}

/** An invoice awaiting settlement, with who/what it pays for. */
interface PendingPurchase {
  session: Session;
  skinId: string;
}

export interface ServerOptions {
  port: number;
  /** Called once per tick after deltas are sent (used by tests). */
  onTick?: (tick: number) => void;
}

export class GameServer {
  readonly world = new World();
  private http: HttpServer;
  private wss: WebSocketServer;
  private sessions = new Set<Session>();
  private timer?: ReturnType<typeof setInterval>;
  private settleTimer?: ReturnType<typeof setInterval>;
  private tick = 0;
  /** Lightning backend (mock by default; swap for BTCPay/LNbits/hosted). */
  private payments: LightningProvider = new MockLightningProvider();
  /** invoiceId -> pending purchase. */
  private pending = new Map<string, PendingPurchase>();

  constructor(private opts: ServerOptions) {
    // An HTTP server fronts the websocket so hosts (Render/Fly/Railway) get a
    // health endpoint, and WS upgrades share the same port.
    this.http = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`chess-openworld ok — ${this.sessions.size} online`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.http.listen(opts.port);
  }

  start(): void {
    const interval = Math.round(1000 / WORLD.tickHz);
    this.timer = setInterval(() => this.step(), interval);
    // Poll pending invoices for settlement (how a real provider's webhook or
    // polling would drive granting). The mock also settles instantly on devPay.
    this.settleTimer = setInterval(() => void this.pollSettlements(), 1500);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.settleTimer) clearInterval(this.settleTimer);
    for (const s of this.sessions) s.socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ---- connection handling --------------------------------------------------

  private onConnection(socket: WebSocket): void {
    let session: Session | null = null;

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { t: "error", message: "bad json" });
      }

      if (msg.t === "join") {
        if (session) return;
        session = this.handleJoin(socket, msg.name, msg.accountId);
        return;
      }
      if (!session) return send(socket, { t: "error", message: "join first" });
      this.handleMessage(session, msg);
    });

    socket.on("close", () => {
      if (session) {
        this.world.removeEntity(session.playerId);
        this.sessions.delete(session);
      }
    });
  }

  private handleJoin(socket: WebSocket, name: string, accountId?: string): Session {
    // Spawn near the shared board so new players find the action.
    const spawnX = this.world.boardOrigin.x + randInt(-6, 6);
    const spawnY = this.world.boardOrigin.y + randInt(-6, 6);
    const account = accountId || randomUUID();
    const wallet = this.world.walletOf(account);
    const player = this.world.addEntity("player", spawnX, spawnY, name || "anon", {
      skin: wallet.equipped.avatar, // wear any previously-purchased avatar skin
    });

    const session: Session = {
      playerId: player.id,
      socket,
      name: player.label,
      known: new Map(),
      lastBoardVersion: -1,
      focus: null,
      pendingMove: null,
      accountId: account,
    };
    this.sessions.add(session);

    send(socket, {
      t: "welcome",
      you: { id: player.id, x: player.x, y: player.y },
      world: WORLD,
      board: this.world.boardSnapshot(),
    });
    // Immediate snapshot so the client can render without waiting a tick.
    const visible = this.world.entitiesInZones(interestZones(player.x, player.y));
    for (const e of visible) session.known.set(e.id, { x: e.x, y: e.y });
    send(socket, { t: "snapshot", entities: visible });
    send(socket, { t: "wallet", wallet });
    session.lastBoardVersion = this.world.boardVersion;
    return session;
  }

  private handleMessage(session: Session, msg: ClientMessage): void {
    switch (msg.t) {
      case "move": {
        // Buffer the latest direction; the tick applies one step (rate limit).
        session.pendingMove = { dx: clampStep(msg.dx), dy: clampStep(msg.dy) };
        break;
      }
      case "place": {
        const p = this.world.getEntity(session.playerId);
        if (!p) return;
        // Don't stack a structure on an already-solid tile.
        if (msg.kind === "building" && this.world.isSolidTile(p.x, p.y)) return;
        this.world.addEntity(msg.kind, p.x, p.y, msg.kind, { skin: msg.skin });
        break;
      }
      case "boardMove": {
        const res = this.world.tryBoardMove(session.playerId, msg.from, msg.to, msg.promotion);
        if (!res.ok) send(session.socket, { t: "error", message: res.reason ?? "rejected" });
        break;
      }
      case "sit": {
        const color = this.world.claimSeat(session.playerId);
        this.world.boardVersion++; // nudge a board resync so new seats show up
        if (!color) send(session.socket, { t: "error", message: "both seats taken — spectating" });
        break;
      }
      case "newGame": {
        const s = this.world.boardSnapshot().status;
        if (s === "playing" || s === "check") {
          send(session.socket, { t: "error", message: "game still in progress" });
        } else {
          this.world.resetBoard();
        }
        break;
      }
      case "focus": {
        const p = this.world.getEntity(session.playerId);
        // Drop the focus once it's basically back on the avatar (following).
        if (p && Math.abs(msg.x - p.x) <= 1 && Math.abs(msg.y - p.y) <= 1) {
          session.focus = null;
        } else {
          session.focus = { x: msg.x, y: msg.y };
        }
        break;
      }
      case "buySkin": {
        void this.handleBuySkin(session, msg.skinId);
        break;
      }
      case "equipSkin": {
        const ok = this.world.equipSkin(session.accountId, msg.slot, msg.skinId);
        if (!ok) {
          send(session.socket, { t: "error", message: "you don't own that skin" });
          break;
        }
        if (msg.slot === "avatar") {
          const e = this.world.getEntity(session.playerId);
          if (e) e.skin = msg.skinId ?? undefined;
          this.resendEntity(session.playerId); // make others see the new look
        }
        send(session.socket, { t: "wallet", wallet: this.world.walletOf(session.accountId) });
        break;
      }
      case "devPay": {
        // MOCK ONLY: simulate the wallet paying, then settle immediately.
        if (this.payments.isMock && this.payments.settle) {
          this.payments.settle(msg.invoiceId);
          void this.settleInvoice(msg.invoiceId);
        } else {
          send(session.socket, { t: "error", message: "devPay disabled (real provider)" });
        }
        break;
      }
      case "chat": {
        this.broadcastNearby(session.playerId, { t: "chat", from: session.name, text: msg.text });
        break;
      }
      case "ping":
        send(session.socket, { t: "pong" });
        break;
    }
  }

  // ---- the tick -------------------------------------------------------------

  private step(): void {
    this.tick++;
    for (const session of this.sessions) {
      const p = this.world.getEntity(session.playerId);
      if (!p) continue;

      // Apply at most one buffered step this tick (authoritative speed limit).
      if (session.pendingMove) {
        this.world.moveEntity(session.playerId, p.x + session.pendingMove.dx, p.y + session.pendingMove.dy);
        session.pendingMove = null;
      }

      // Interest = zones around the avatar, plus zones around the camera focus
      // when the player is panning/spectating elsewhere.
      const zones = interestZones(p.x, p.y);
      if (session.focus) for (const z of interestZones(session.focus.x, session.focus.y)) zones.add(z);
      const current = this.world.entitiesInZones(zones);
      const currentById = new Map<EntityId, Entity>(current.map((e) => [e.id, e]));

      const enter: Entity[] = [];
      const move: { id: EntityId; x: number; y: number }[] = [];
      const leave: EntityId[] = [];

      for (const e of current) {
        const prev = session.known.get(e.id);
        if (!prev) {
          enter.push(e);
        } else if (prev.x !== e.x || prev.y !== e.y) {
          move.push({ id: e.id, x: e.x, y: e.y });
        }
      }
      for (const id of session.known.keys()) {
        if (!currentById.has(id)) leave.push(id);
      }

      if (enter.length || move.length || leave.length) {
        send(session.socket, { t: "delta", enter, leave, move });
        session.known = new Map(current.map((e) => [e.id, { x: e.x, y: e.y }]));
      }

      // Lazy board sync: only to players who can see the board and are stale.
      if (
        session.lastBoardVersion !== this.world.boardVersion &&
        zones.has(zoneOf(this.world.boardOrigin.x, this.world.boardOrigin.y))
      ) {
        send(session.socket, { t: "board", board: this.world.boardSnapshot() });
        session.lastBoardVersion = this.world.boardVersion;
      }
    }
    this.opts.onTick?.(this.tick);
  }

  private broadcastNearby(originId: EntityId, msg: ServerMessage): void {
    const origin = this.world.getEntity(originId);
    if (!origin) return;
    const zones = interestZones(origin.x, origin.y);
    for (const s of this.sessions) {
      const p = this.world.getEntity(s.playerId);
      if (p && zones.has(zoneOf(p.x, p.y))) send(s.socket, msg);
    }
  }

  // ---- payments -------------------------------------------------------------

  private async handleBuySkin(session: Session, skinId: string): Promise<void> {
    const item = skinById(skinId);
    if (!item) return send(session.socket, { t: "error", message: "unknown skin" });
    if (this.world.walletOf(session.accountId).owned.includes(skinId)) {
      return send(session.socket, { t: "error", message: "already owned" });
    }
    const invoice = await this.payments.createInvoice(item.priceSats, `skin:${skinId}`);
    this.pending.set(invoice.id, { session, skinId });
    send(session.socket, {
      t: "invoice",
      invoiceId: invoice.id,
      skinId,
      bolt11: invoice.bolt11,
      amountSats: invoice.amountSats,
    });
  }

  /** Grant the skin if (and only if) the provider confirms the invoice paid. */
  private async settleInvoice(invoiceId: string): Promise<void> {
    const purchase = this.pending.get(invoiceId);
    if (!purchase) return; // unknown or already settled (idempotent)
    if ((await this.payments.getStatus(invoiceId)) !== "paid") return;
    this.pending.delete(invoiceId);
    this.world.grantSkin(purchase.session.accountId, purchase.skinId);
    send(purchase.session.socket, { t: "purchased", skinId: purchase.skinId });
    send(purchase.session.socket, {
      t: "wallet",
      wallet: this.world.walletOf(purchase.session.accountId),
    });
  }

  private async pollSettlements(): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.settleInvoice(id);
  }

  /** Drop an entity from every client's known set so it re-streams in full
   * (used when a cosmetic like an avatar skin changes). */
  private resendEntity(id: EntityId): void {
    for (const s of this.sessions) s.known.delete(id);
  }
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function clampStep(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : Math.round(v);
}

function randInt(lo: number, hi: number): number {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
