import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { requireUser } from "@/server/auth";
import { clawBotConnector } from "@/server/clawbot";
import { db } from "@/server/db";
import { bindingSessions } from "@/server/db/schema";
import { apiError } from "@/server/http";

export async function POST() {
  try {
    const user = await requireUser();
    const [existing] = await db.select().from(bindingSessions).where(eq(bindingSessions.userId, user.id)).orderBy(desc(bindingSessions.createdAt)).limit(1);
    if (existing && existing.expiresAt > new Date() && existing.status === "pending") {
      return NextResponse.json({ session: { id: existing.id, qrValue: existing.qrValue, expiresAt: existing.expiresAt, status: existing.status }, reused: true });
    }
    const started = await clawBotConnector.startBinding();
    const [session] = await db.insert(bindingSessions).values({ userId: user.id, connectorSessionKey: started.connectorSessionKey, connectorBaseUrl: started.baseUrl, qrValue: started.qrValue, expiresAt: new Date(started.expiresAt) }).returning({ id: bindingSessions.id, qrValue: bindingSessions.qrValue, expiresAt: bindingSessions.expiresAt, status: bindingSessions.status });
    return NextResponse.json({ session, requestId: randomUUID() }, { status: 201 });
  } catch (error) { return apiError(error); }
}
