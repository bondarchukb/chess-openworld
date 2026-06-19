/**
 * Money ledger — the real-money safety layer on top of the in-game sats balance
 * (StatsStore.sats). It does three jobs the raw balance can't:
 *   1. Idempotency: a payment hash credits/debits at most once (anti double-spend).
 *   2. Solvency: the pool never pays out more real sats than it took in.
 *   3. Audit: an append-only entry log of every money movement.
 *
 * In-game transfers (captures, jackpot, spawn cost) stay in StatsStore; only the
 * real-money boundary (deposit/withdraw) and explicit purchases go through here.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { StatsStore } from "./stats.js";

export type LedgerKind = "deposit" | "withdraw" | "refund" | "buyPiece" | "buyOpponentPiece";

export interface LedgerEntry {
  id: string;
  ts: number;
  account: string;
  delta: number;
  kind: LedgerKind;
  ref?: string;
  idempotencyKey: string;
}

export interface PersistedLedger {
  entries: LedgerEntry[];
  poolReceived: number;
  poolPaidOut: number;
}

export class Ledger {
  private entries: LedgerEntry[] = [];
  private seen = new Set<string>();
  /** Total real sats deposited into the pool wallet. */
  private poolReceived = 0;
  /** Total real sats paid out of the pool wallet. */
  private poolPaidOut = 0;

  constructor(private stats: StatsStore) {}

  private record(account: string, delta: number, kind: LedgerKind, idem: string, ref?: string): boolean {
    if (this.seen.has(idem)) return false;
    this.seen.add(idem);
    this.entries.push({ id: randomUUID(), ts: Date.now(), account, delta, kind, ref, idempotencyKey: idem });
    return true;
  }

  /** Pool can cover this payout without going insolvent. */
  canPayout(sats: number): boolean {
    return this.poolReceived - this.poolPaidOut >= sats;
  }

  balanceOf(account: string): number {
    return this.stats.get(account).sats;
  }

  /** Credit a confirmed deposit. Idempotent per payment hash. */
  deposit(account: string, sats: number, paymentHash: string): boolean {
    if (!this.record(account, sats, "deposit", `deposit:${paymentHash}`, paymentHash)) return false;
    this.stats.get(account).sats += sats;
    this.poolReceived += sats;
    return true;
  }

  /** Reserve a withdrawal: debit balance up front (before paying out). Fails if
   * the player lacks funds, the pool would go insolvent, or it's a duplicate. */
  reserveWithdraw(account: string, sats: number, ref: string): boolean {
    if (sats <= 0) return false;
    if (this.stats.get(account).sats < sats) return false;
    if (!this.canPayout(sats)) return false;
    if (!this.record(account, -sats, "withdraw", `withdraw:${ref}`, ref)) return false;
    this.stats.get(account).sats -= sats;
    this.poolPaidOut += sats;
    return true;
  }

  /** Undo a reserved withdrawal when the payout itself fails. */
  refundWithdraw(account: string, sats: number, ref: string): void {
    this.stats.get(account).sats += sats;
    this.poolPaidOut -= sats;
    this.record(account, sats, "refund", `refund:${ref}`, ref);
  }

  /** Move sats between two players (purchase). Atomic; fails if buyer is short. */
  transfer(from: string, to: string, sats: number, kind: LedgerKind, ref: string): boolean {
    if (sats <= 0) return false;
    if (this.stats.get(from).sats < sats) return false;
    if (!this.record(from, -sats, kind, `${kind}:${ref}`, ref)) return false;
    this.record(to, sats, kind, `${kind}:${ref}:in`, `${ref}:in`);
    this.stats.get(from).sats -= sats;
    this.stats.get(to).sats += sats;
    return true;
  }

  serialize(): PersistedLedger {
    return { entries: this.entries, poolReceived: this.poolReceived, poolPaidOut: this.poolPaidOut };
  }

  loadFrom(data: PersistedLedger | undefined): void {
    if (!data) return;
    this.entries = data.entries ?? [];
    this.poolReceived = data.poolReceived ?? 0;
    this.poolPaidOut = data.poolPaidOut ?? 0;
    this.seen = new Set(this.entries.map((e) => e.idempotencyKey));
  }
}

export async function saveLedger(ledger: Ledger, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(ledger.serialize(), null, 2), "utf8");
}

export async function loadLedger(ledger: Ledger, path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  ledger.loadFrom(JSON.parse(await readFile(path, "utf8")) as PersistedLedger);
  return true;
}
