/**
 * Thin websocket wrapper. Holds the local replica of the piece set the server
 * streams (interest set around the camera). Client renders this, never authors.
 */

import type {
  ArmyId,
  ClientMessage,
  GameMode,
  Piece,
  PieceId,
  PlayerStats,
  SelfInfo,
  ServerMessage,
} from "@chess-openworld/protocol";

export interface RosterEntry {
  id: ArmyId;
  name: string;
  color: string;
  spawnX: number;
  spawnY: number;
  inCheck: boolean;
  elo: number;
  sats: number;
  dead: boolean;
  gameMode: GameMode;
  inArena: boolean;
}

export interface DeadInfo {
  reason: string;
  killerName: string;
  killerElo: number;
  eloDelta: number;
  satsDelta: number;
  newStats: PlayerStats;
  respawnAt: number;
}

export class Connection {
  private socket: WebSocket;
  self: SelfInfo | null = null;
  pieces = new Map<PieceId, Piece>();
  roster: RosterEntry[] = [];
  stats: PlayerStats | null = null;
  dead: DeadInfo | null = null;
  /** Best-known server clock offset (serverNow - clientNow), ms. */
  serverOffset = 0;
  onStatus: (text: string) => void = () => {};
  onOpen: () => void = () => {};
  onWelcome: (self: SelfInfo) => void = () => {};
  onDead: (info: DeadInfo) => void = () => {};
  onRespawned: () => void = () => {};
  onDominationWin: (info: { winnerName: string; winnerArmyId: ArmyId; satsJackpot: number }) => void = () => {};
  onInvoice: (info: { invoiceId: string; bolt11: string; sats: number }) => void = () => {};
  onDepositCredited: (info: { sats: number; balance: number }) => void = () => {};
  onWithdrawResult: (info: { ok: boolean; sats: number; balance: number; reason?: string }) => void = () => {};
  onBalance: (sats: number) => void = () => {};
  onOfferReceived: (info: { offerId: string; pieceId: PieceId; pieceType: string; price: number; fromName: string }) => void = () => {};
  onOfferResolved: (info: { ok: boolean; reason?: string }) => void = () => {};
  onOfferCancelled: (offerId: string) => void = () => {};

  constructor(
    url: string,
    private playerName: string,
    private spawnMode: "classical" | "blob" = "classical",
    private asSpectator: boolean = false,
    private gameMode: GameMode = "open",
    private accountId: string | undefined = undefined,
    private autoJoin: boolean = true,
  ) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      this.onOpen();
      if (this.autoJoin) this.join();
    });
    this.socket.addEventListener("close", () => this.onStatus("disconnected"));
    this.socket.addEventListener("error", () => this.onStatus("connection error"));
    this.socket.addEventListener("message", (ev) => {
      this.handle(JSON.parse(ev.data) as ServerMessage);
    });
  }

  serverNow(): number {
    return Date.now() + this.serverOffset;
  }

  private syncClock(serverNow: number): void {
    this.serverOffset = serverNow - Date.now();
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.self = msg.you;
        this.stats = msg.you.stats;
        this.syncClock(msg.serverNow);
        this.onStatus(`in world as ${msg.you.name}`);
        this.onWelcome(msg.you);
        break;
      case "snapshot":
        this.syncClock(msg.serverNow);
        this.pieces.clear();
        for (const p of msg.pieces) this.pieces.set(p.id, p);
        break;
      case "delta":
        this.syncClock(msg.serverNow);
        for (const p of msg.enter) this.pieces.set(p.id, p);
        for (const m of msg.move) {
          const p = this.pieces.get(m.id);
          if (p) {
            p.x = m.x;
            p.y = m.y;
            p.readyAt = m.readyAt;
          }
        }
        for (const c of msg.cooldown) {
          const p = this.pieces.get(c.id);
          if (p) {
            p.readyAt = c.readyAt;
            if (c.forward !== undefined) p.forward = c.forward;
          }
        }
        for (const id of msg.leave) this.pieces.delete(id);
        break;
      case "dead":
        this.dead = {
          reason: msg.reason,
          killerName: msg.killerName,
          killerElo: msg.killerElo,
          eloDelta: msg.eloDelta,
          satsDelta: msg.satsDelta,
          newStats: msg.newStats,
          respawnAt: msg.respawnAt,
        };
        this.stats = msg.newStats;
        this.onDead(this.dead);
        break;
      case "respawned":
        this.stats = msg.stats;
        if (this.dead) {
          this.dead = null;
          this.onRespawned();
        }
        break;
      case "roster":
        this.roster = msg.armies;
        break;
      case "dominationWin":
        this.onDominationWin({
          winnerName: msg.winnerName,
          winnerArmyId: msg.winnerArmyId,
          satsJackpot: msg.satsJackpot,
        });
        break;
      case "invoice":
        this.onInvoice({ invoiceId: msg.invoiceId, bolt11: msg.bolt11, sats: msg.sats });
        break;
      case "depositCredited":
        if (this.stats) this.stats.sats = msg.balance;
        this.onDepositCredited({ sats: msg.sats, balance: msg.balance });
        break;
      case "withdrawResult":
        if (this.stats) this.stats.sats = msg.balance;
        this.onWithdrawResult({ ok: msg.ok, sats: msg.sats, balance: msg.balance, reason: msg.reason });
        break;
      case "balance":
        if (this.stats) this.stats.sats = msg.sats;
        this.onBalance(msg.sats);
        break;
      case "offerReceived":
        this.onOfferReceived({ offerId: msg.offerId, pieceId: msg.pieceId, pieceType: msg.pieceType, price: msg.price, fromName: msg.fromName });
        break;
      case "offerResolved":
        this.onOfferResolved({ ok: msg.ok, reason: msg.reason });
        break;
      case "offerCancelled":
        this.onOfferCancelled(msg.offerId);
        break;
      case "error":
        this.onStatus(`server: ${msg.message}`);
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  /** Join the world. Call manually when autoJoin=false (e.g. after an entry deposit). */
  join(): void {
    this.onStatus("connected — joining…");
    this.send({
      t: "join",
      name: this.playerName,
      accountId: this.accountId,
      spawnMode: this.spawnMode,
      asSpectator: this.asSpectator,
      gameMode: this.gameMode,
    });
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  requestDeposit(sats: number): void {
    this.send({ t: "depositRequest", sats, accountId: this.accountId });
  }
  requestWithdraw(lnAddress: string, sats: number): void {
    this.send({ t: "withdrawRequest", lnAddress, sats });
  }
  buyOffer(pieceId: PieceId, price: number): void {
    this.send({ t: "buyOffer", pieceId, price });
  }
  respondOffer(offerId: string, accept: boolean): void {
    this.send({ t: "offerResponse", offerId, accept });
  }
  cancelOffer(): void {
    this.send({ t: "cancelOffer" });
  }
}
