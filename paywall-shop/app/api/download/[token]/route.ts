import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { bumpDownloadCount, getOrderByToken } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const order = getOrderByToken(token);
  if (!order || order.status !== "paid") {
    return NextResponse.json({ error: "invalid token" }, { status: 404 });
  }

  const ttlHours = Number(process.env.DOWNLOAD_TOKEN_TTL_HOURS ?? "72");
  const expiresAt = (order.paid_at ?? order.created_at) + ttlHours * 3600_000;
  if (Date.now() > expiresAt) {
    return NextResponse.json({ error: "download link expired" }, { status: 410 });
  }

  const filePath = path.resolve(process.cwd(), process.env.DELIVERABLE_FILE_PATH ?? "./deliverables/lightning-paywall-kit.zip");
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "file missing on server" }, { status: 500 });
  }

  bumpDownloadCount(order.id);

  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const stream = fs.createReadStream(filePath);

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
