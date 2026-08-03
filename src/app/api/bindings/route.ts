import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireUser } from "@/server/auth";
import { clawBotConnector } from "@/server/clawbot";
import { db } from "@/server/db";
import { wechatBindings } from "@/server/db/schema";
import { apiError } from "@/server/http";

export async function GET() {
  try {
    const user = await requireUser();
    const [binding] = await db.select({ id: wechatBindings.id, status: wechatBindings.status, accountId: wechatBindings.accountId, weixinUserId: wechatBindings.weixinUserId, boundAt: wechatBindings.boundAt, lastInboundAt: wechatBindings.lastInboundAt, lastSuccessfulSendAt: wechatBindings.lastSuccessfulSendAt }).from(wechatBindings).where(eq(wechatBindings.userId, user.id)).limit(1);
    return NextResponse.json({ binding: binding ?? null, connectorConfigured: clawBotConnector.configured() });
  } catch (error) { return apiError(error); }
}

export async function DELETE() {
  try {
    const user = await requireUser();
    await db.delete(wechatBindings).where(eq(wechatBindings.userId, user.id));
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
