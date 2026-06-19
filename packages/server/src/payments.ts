/**
 * Lightning payments — provider-agnostic.
 *
 * The game never holds user balances and never trusts the client about money:
 * it mints an invoice, then waits for the *provider* to confirm settlement
 * before granting anything. Swap the provider to go live (BTCPay / LNbits /
 * a hosted API) without touching game code.
 *
 * SECURITY NOTES for a real deployment:
 *  - Verify settlement server-side via signed webhook or authenticated poll —
 *    never act on a client claiming "I paid".
 *  - Make granting idempotent (an invoice grants its skin at most once).
 *  - Always start on testnet/regtest. Price in sats.
 */

import { randomUUID } from "node:crypto";

export type InvoiceStatus = "pending" | "paid" | "expired";

export interface Invoice {
  id: string;
  /** BOLT11 payment request the wallet scans/pays. */
  bolt11: string;
  amountSats: number;
  status: InvoiceStatus;
  createdAt: number;
}

export interface PayoutResult {
  ok: boolean;
  /** Provider payment id / preimage on success. */
  reference?: string;
  reason?: string;
}

export interface LightningProvider {
  /** True for the mock provider, which allows simulated settlement. */
  readonly isMock: boolean;
  createInvoice(amountSats: number, memo: string): Promise<Invoice>;
  getStatus(invoiceId: string): Promise<InvoiceStatus>;
  /** Send sats to a Lightning address (the withdraw / payout leg). */
  payAddress(lnAddress: string, amountSats: number, memo?: string): Promise<PayoutResult>;
  /** MOCK ONLY: mark an invoice paid, simulating a wallet paying it. */
  settle?(invoiceId: string): void;
}

/**
 * A fake Lightning backend for development and tests. It produces realistic-
 * looking (but non-spendable) BOLT11 strings and only "settles" when the dev
 * explicitly triggers it — so the full purchase flow can be exercised with no
 * real money, accounts, or network.
 */
export class MockLightningProvider implements LightningProvider {
  readonly isMock = true;
  private invoices = new Map<string, Invoice>();

  async createInvoice(amountSats: number, _memo: string): Promise<Invoice> {
    const id = randomUUID();
    const inv: Invoice = {
      id,
      bolt11: `lntbs${amountSats}n1mock${id.replace(/-/g, "").slice(0, 24)}`,
      amountSats,
      status: "pending",
      createdAt: Date.now(),
    };
    this.invoices.set(id, inv);
    return inv;
  }

  async getStatus(invoiceId: string): Promise<InvoiceStatus> {
    return this.invoices.get(invoiceId)?.status ?? "expired";
  }

  settle(invoiceId: string): void {
    const inv = this.invoices.get(invoiceId);
    if (inv && inv.status === "pending") inv.status = "paid";
  }

  async payAddress(lnAddress: string, amountSats: number): Promise<PayoutResult> {
    return { ok: true, reference: `mockpay-${lnAddress}-${amountSats}` };
  }
}

/**
 * Real Lightning via coinos.io REST API. One bearer token drives both legs:
 *   receive  -> POST /invoice               (mint a bolt11 to top up)
 *   confirm  -> GET  /invoice/:hash         (poll until received >= amount)
 *   send     -> POST /send/:lnaddr/:amount  (pay a winner's Lightning address)
 *
 * SECURITY: the token has full spend authority over the pooled wallet. Keep it
 * server-side only. Start on testnet.
 */
export class CoinosProvider implements LightningProvider {
  readonly isMock = false;
  private base: string;
  private amounts = new Map<string, number>(); // hash -> expected sats

  constructor(private token: string, base = process.env.COINOS_URL ?? "https://coinos.io/api") {
    this.base = base.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.token}` };
  }

  async createInvoice(amountSats: number, memo: string): Promise<Invoice> {
    const res = await fetch(`${this.base}/invoice`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ invoice: { amount: amountSats, type: "lightning", memo } }),
    });
    if (!res.ok) throw new Error(`coinos invoice ${res.status}`);
    const data = (await res.json()) as { hash?: string; text?: string; bolt11?: string };
    const hash = data.hash;
    const bolt11 = data.text ?? data.bolt11;
    if (!hash || !bolt11) throw new Error("coinos invoice missing hash/bolt11");
    this.amounts.set(hash, amountSats);
    return { id: hash, bolt11, amountSats, status: "pending", createdAt: Date.now() };
  }

  async getStatus(invoiceId: string): Promise<InvoiceStatus> {
    const res = await fetch(`${this.base}/invoice/${invoiceId}`, { headers: this.headers() });
    if (!res.ok) return "pending";
    const data = (await res.json()) as { received?: number; amount?: number };
    const want = this.amounts.get(invoiceId) ?? data.amount ?? 0;
    return (data.received ?? 0) >= want && want > 0 ? "paid" : "pending";
  }

  async payAddress(lnAddress: string, amountSats: number): Promise<PayoutResult> {
    const res = await fetch(`${this.base}/send/${encodeURIComponent(lnAddress)}/${amountSats}`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) return { ok: false, reason: `coinos send ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { hash?: string };
    return { ok: true, reference: data.hash };
  }
}

/** Pick a provider from env: CoinosProvider if COINOS_TOKEN is set, else mock. */
export function providerFromEnv(): LightningProvider {
  const token = process.env.COINOS_TOKEN;
  if (token) return new CoinosProvider(token);
  return new MockLightningProvider();
}
