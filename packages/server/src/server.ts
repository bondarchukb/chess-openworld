/**
 * Networking + per-tick interest streaming for the open-plane chess world.
 *
 * Per tick, for each session we:
 *   1. compute the 3x3 zone neighborhood around the player's camera focus
 *      (defaults to their army's spawn until they pan),
 *   2. diff vs what the client last knew (enter / move / leave),
 *   3. send only the changes.
 *
 * Movement is real-time with per-piece cooldown enforced in world.tryMove.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  WORLD,
  interestZones,
  zoneOf,
  type ArmyId,
  type ClientMessage,
  type GameMode,
  type Piece,
  type PieceId,
  type ServerMessage,
} from "@chess-openworld/protocol";
import { World } from "./world.js";
import { StatsStore, saveStats } from "./stats.js";

interface Session {
  /** null for spectators. */
  armyId: ArmyId | null;
  socket: WebSocket;
  name: string;
  /** Last known pieces in interest set (id -> last sent {x,y,readyAt,forward}). */
  known: Map<PieceId, { x: number; y: number; readyAt: number; forwardKey: string }>;
  focus: { x: number; y: number };
  /** Pieces whose forward changed since the last tick — forces a forward push. */
  forwardDirty: Set<PieceId>;
}

export interface ServerOptions {
  port: number;
  /** Where stats.json lives. Server auto-saves stats on every death. */
  statsPath?: string;
  onTick?: (tick: number) => void;
}

export class GameServer {
  readonly world = new World();
  readonly stats = new StatsStore();
  private http: HttpServer;
  private wss: WebSocketServer;
  private sessions = new Set<Session>();
  private timer?: ReturnType<typeof setInterval>;
  private tick = 0;
  /** Per-army pending respawn timers (so a player who disconnects mid-death doesn't strand a timer). */
  private respawnTimers = new Map<ArmyId, ReturnType<typeof setTimeout>>();

  constructor(private opts: ServerOptions) {
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
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
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
        session = msg.asSpectator
          ? this.handleSpectatorJoin(socket, msg.name)
          : this.handleJoin(socket, msg.name, msg.spawnMode ?? "classical", msg.gameMode ?? "open");
        return;
      }
      if (!session) return send(socket, { t: "error", message: "join first" });
      this.handleMessage(session, msg);
    });

    socket.on("close", () => {
      if (session) {
        if (session.armyId) {
          const timer = this.respawnTimers.get(session.armyId);
          if (timer) {
            clearTimeout(timer);
            this.respawnTimers.delete(session.armyId);
          }
          this.world.removeArmy(session.armyId);
        }
        this.sessions.delete(session);
        this.broadcastRoster();
      }
    });
  }

  private broadcastRoster(): void {
    const armies = [...this.world.armies.values()].map((a) => {
      const s = this.stats.get(a.name);
      return {
        id: a.id, name: a.name, color: a.color,
        spawnX: a.spawnX, spawnY: a.spawnY,
        inCheck: a.inCheck,
        elo: s.elo,
        sats: s.sats,
        dead: a.dead,
        gameMode: a.gameMode,
        inArena: a.gameMode === "domination" && !a.dead && this.world.armyHasPieceInArena(a.id),
      };
    });
    const msg: ServerMessage = { t: "roster", armies };
    for (const s of this.sessions) send(s.socket, msg);
    this.checkDominationWinner();
  }

  /** When exactly one domination army still has presence in the arena, the
   * match is over. Award them the sum of all their opponents' current sats
   * (winner takes all the altar stakes). */
  private checkDominationWinner(): void {
    // Gate on total participants — a just-eliminated army is `dead` but kept as
    // a participant shell (wipeArmy), so it must still count toward the match.
    const participants = [...this.world.armies.values()].filter((a) => a.gameMode === "domination");
    if (participants.length < 2) return;
    // A contender is alive AND still holding the arena. Win when exactly one
    // remains — covers both "opponents killed" and "opponents pushed out".
    const contenders = participants.filter((a) => !a.dead && this.world.armyHasPieceInArena(a.id));
    if (contenders.length !== 1) return;
    const winner = contenders[0]!;
    let jackpot = 0;
    for (const loser of participants) {
      if (loser.id === winner.id) continue;
      const s = this.stats.get(loser.name);
      jackpot += s.sats;
      s.sats = 0;
    }
    this.stats.get(winner.name).sats += jackpot;
    const msg: ServerMessage = {
      t: "dominationWin",
      winnerName: winner.name,
      winnerArmyId: winner.id,
      satsJackpot: jackpot,
    };
    for (const s of this.sessions) send(s.socket, msg);
    // Reset arena: cancel any pending death-respawn (else a wiped army respawns
    // twice), then respawn every participant so the next match starts fresh.
    for (const a of participants) {
      const timer = this.respawnTimers.get(a.id);
      if (timer) {
        clearTimeout(timer);
        this.respawnTimers.delete(a.id);
      }
      this.stats.chargeSpawn(a.name);
      this.world.respawnArmy(a);
      const sess = [...this.sessions].find((s) => s.armyId === a.id);
      if (sess) sess.focus = { x: a.spawnX, y: a.spawnY };
    }
    void this.persistStats();
  }

  private handleJoin(
    socket: WebSocket,
    name: string,
    spawnMode: "classical" | "blob",
    gameMode: GameMode,
  ): Session {
    // Charge spawn cost up front. Broke players still get an army (partial
    // charge) — losing pieces will be the real penalty.
    this.stats.chargeSpawn(name || "anon");
    const army = this.world.spawnArmy(name || "anon", spawnMode, gameMode);
    const session: Session = {
      armyId: army.id,
      socket,
      name: army.name,
      known: new Map(),
      focus: { x: army.spawnX, y: army.spawnY },
      forwardDirty: new Set(),
    };
    this.sessions.add(session);

    const now = Date.now();
    const stats = this.stats.get(session.name);
    send(socket, {
      t: "welcome",
      you: {
        armyId: army.id, name: army.name, color: army.color,
        spawnX: army.spawnX, spawnY: army.spawnY,
        stats,
        spectator: false,
      },
      world: WORLD,
      serverNow: now,
    });
    const visible = this.world.piecesInZones(interestZones(session.focus.x, session.focus.y));
    for (const p of visible) session.known.set(p.id, { x: p.x, y: p.y, readyAt: p.readyAt, forwardKey: forwardKey(p.forward) });
    send(socket, { t: "snapshot", pieces: visible, serverNow: now });
    this.broadcastRoster();
    return session;
  }

  /** Spectator: no army, no stats, free camera. */
  private handleSpectatorJoin(socket: WebSocket, name: string): Session {
    const session: Session = {
      armyId: null,
      socket,
      name: name || "anon-spectator",
      known: new Map(),
      // Default focus to (0,0) — first army's spawn. Spectator can pan.
      focus: { x: 0, y: 0 },
      forwardDirty: new Set(),
    };
    this.sessions.add(session);
    const now = Date.now();
    send(socket, {
      t: "welcome",
      you: {
        armyId: null,
        name: session.name,
        color: "#888888",
        spawnX: 0, spawnY: 0,
        stats: { elo: 0, wins: 0, losses: 0, kills: 0, deaths: 0, sats: 0 },
        spectator: true,
      },
      world: WORLD,
      serverNow: now,
    });
    const visible = this.world.piecesInZones(interestZones(session.focus.x, session.focus.y));
    for (const p of visible) session.known.set(p.id, { x: p.x, y: p.y, readyAt: p.readyAt, forwardKey: forwardKey(p.forward) });
    send(socket, { t: "snapshot", pieces: visible, serverNow: now });
    // Roster comes from broadcastRoster on the next state change; send now too.
    this.broadcastRoster();
    return session;
  }

  private handleMessage(session: Session, msg: ClientMessage): void {
    // Spectators may pan their focus (interest streaming) but nothing else.
    if (!session.armyId && msg.t !== "focus" && msg.t !== "ping") {
      return;
    }
    switch (msg.t) {
      case "pieceMove": {
        const piece = this.world.getPiece(msg.pieceId);
        if (!piece) return send(session.socket, { t: "error", message: "no such piece" });
        if (piece.owner !== session.armyId) {
          return send(session.socket, { t: "error", message: "not your piece" });
        }
        const army = this.world.getArmy(session.armyId);
        if (army?.dead) return send(session.socket, { t: "error", message: "you are dead" });
        const res = this.world.tryMove(piece.id, msg.toX, msg.toY, Date.now());
        if (!res.ok) {
          send(session.socket, { t: "error", message: res.reason });
          return;
        }
        // Always recompute roster when any domination match is live — the
        // inArena flag is what tells clients who's still in the running.
        const anyDomination = [...this.world.armies.values()].some((a) => a.gameMode === "domination");
        let rosterDirty = res.checkChanged || res.matedArmies.length > 0 || anyDomination;
        // Per-piece sat transfer for any non-king capture.
        if (res.captured && !res.capturedKingOf) {
          const victimArmy = this.world.getArmy(res.captured.owner);
          if (victimArmy) {
            this.stats.transferCapture(session.name, victimArmy.name, res.captured.type);
            rosterDirty = true;
            void this.persistStats();
          }
        }
        if (res.capturedKingOf) this.handleArmyDeath(res.capturedKingOf, "king captured", session);
        for (const armyId of res.matedArmies) {
          if (armyId === session.armyId) continue;
          this.handleArmyDeath(armyId, "checkmate", session);
        }
        if (rosterDirty) this.broadcastRoster();
        break;
      }
      case "reorient": {
        const piece = this.world.getPiece(msg.pieceId);
        if (!piece) return send(session.socket, { t: "error", message: "no such piece" });
        if (piece.owner !== session.armyId) {
          return send(session.socket, { t: "error", message: "not your piece" });
        }
        const res = this.world.tryReorient(piece.id, msg.dir, Date.now());
        if (!res.ok) return send(session.socket, { t: "error", message: res.reason });
        // Mark dirty across every session that already sees this piece,
        // so the next tick re-broadcasts the new forward vector.
        for (const s of this.sessions) {
          if (s.known.has(piece.id)) s.forwardDirty.add(piece.id);
        }
        break;
      }
      case "focus": {
        session.focus = { x: msg.x, y: msg.y };
        break;
      }
      case "ping":
        send(session.socket, { t: "pong" });
        break;
    }
  }

  private handleArmyDeath(victimArmyId: ArmyId, reason: string, killer: Session): void {
    const army = this.world.getArmy(victimArmyId);
    if (!army) return;
    if (army.dead) return; // already dying, ignore double-trigger
    const victimSession = [...this.sessions].find((s) => s.armyId === victimArmyId);
    const victimName = victimSession?.name ?? army.name;
    const killerStatsBefore = this.stats.get(killer.name);
    const killerEloBefore = killerStatsBefore.elo;
    const { winnerDelta, loserDelta, satsTransferred } = this.stats.applyKill(killer.name, victimName);
    const victimStats = this.stats.get(victimName);
    void winnerDelta;
    // Wipe board pieces immediately; respawn after delay.
    this.world.wipeArmy(victimArmyId);
    const respawnAt = Date.now() + WORLD.respawnDelayMs;
    if (victimSession) {
      send(victimSession.socket, {
        t: "dead",
        reason,
        killerName: killer.name,
        killerElo: killerEloBefore,
        eloDelta: loserDelta,
        satsDelta: -satsTransferred,
        newStats: victimStats,
        respawnAt,
      });
    }
    // Push refreshed stats to killer too so their HUD updates.
    send(killer.socket, {
      t: "respawned", // reuse: just a stats refresh; client treats as no-op if alive
      stats: this.stats.get(killer.name),
    });
    // Schedule respawn.
    const existing = this.respawnTimers.get(victimArmyId);
    if (existing) clearTimeout(existing);
    this.respawnTimers.set(
      victimArmyId,
      setTimeout(() => this.completeRespawn(victimArmyId), WORLD.respawnDelayMs)
    );
    this.broadcastRoster();
    void this.persistStats();
  }

  private completeRespawn(armyId: ArmyId): void {
    this.respawnTimers.delete(armyId);
    const army = this.world.getArmy(armyId);
    if (!army) return;
    // Charge the spawn cost again for the new army.
    this.stats.chargeSpawn(army.name);
    this.world.respawnArmy(army);
    const victimSession = [...this.sessions].find((s) => s.armyId === armyId);
    if (victimSession) {
      victimSession.focus = { x: army.spawnX, y: army.spawnY };
      send(victimSession.socket, { t: "respawned", stats: this.stats.get(victimSession.name) });
    }
    this.broadcastRoster();
  }

  private async persistStats(): Promise<void> {
    if (this.opts.statsPath) {
      try {
        await saveStats(this.stats, this.opts.statsPath);
      } catch (err) {
        console.error("stats save failed", err);
      }
    }
  }

  // ---- the tick -------------------------------------------------------------

  private step(): void {
    this.tick++;
    const now = Date.now();
    for (const session of this.sessions) {
      const zones = interestZones(session.focus.x, session.focus.y);
      const current = this.world.piecesInZones(zones);
      const currentById = new Map<PieceId, Piece>(current.map((p) => [p.id, p]));

      const enter: Piece[] = [];
      const move: { id: PieceId; x: number; y: number; readyAt: number }[] = [];
      const cooldown: { id: PieceId; readyAt: number; forward?: [number, number] | null }[] = [];
      const leave: PieceId[] = [];

      for (const p of current) {
        const prev = session.known.get(p.id);
        const fwdKey = forwardKey(p.forward);
        if (!prev) {
          enter.push(p);
        } else if (prev.x !== p.x || prev.y !== p.y) {
          move.push({ id: p.id, x: p.x, y: p.y, readyAt: p.readyAt });
        } else {
          const forwardChanged = session.forwardDirty.has(p.id) || prev.forwardKey !== fwdKey;
          if (prev.readyAt !== p.readyAt || forwardChanged) {
            const entry: { id: PieceId; readyAt: number; forward?: [number, number] | null } = {
              id: p.id,
              readyAt: p.readyAt,
            };
            if (forwardChanged) entry.forward = p.forward;
            cooldown.push(entry);
          }
        }
      }
      for (const id of session.known.keys()) {
        if (!currentById.has(id)) leave.push(id);
      }

      if (enter.length || move.length || leave.length || cooldown.length) {
        send(session.socket, { t: "delta", enter, leave, move, cooldown, serverNow: now });
        const next = new Map<PieceId, { x: number; y: number; readyAt: number; forwardKey: string }>();
        for (const p of current) next.set(p.id, { x: p.x, y: p.y, readyAt: p.readyAt, forwardKey: forwardKey(p.forward) });
        session.known = next;
      }
      session.forwardDirty.clear();
    }
    this.opts.onTick?.(this.tick);
  }
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function forwardKey(fwd: [number, number] | null): string {
  return fwd ? `${fwd[0]},${fwd[1]}` : "none";
}

// zoneOf is unused here directly, kept import for parity with old code/tests.
void zoneOf;
