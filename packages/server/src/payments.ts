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

export interface LightningProvider {
  /** True for the mock provider, which allows simulated settlement. */
  readonly isMock: boolean;
  createInvoice(amountSats: number, memo: string): Promise<Invoice>;
  getStatus(invoiceId: string): Promise<InvoiceStatus>;
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
}
