import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { deliveryAttempts, reminders } from "@/server/db/schema";
import { apiError } from "@/server/http";
import { deliveryLatencyMs } from "@/lib/delivery-timing";

export async function GET() {
  try {
    const user = await requireUser();
    const attempts = await db.select({ id: deliveryAttempts.id, reminderId: deliveryAttempts.reminderId, title: reminders.title, status: deliveryAttempts.status, attempt: deliveryAttempts.attempt, scheduledAt: deliveryAttempts.scheduledAt, sentAt: deliveryAttempts.sentAt, providerMessageId: deliveryAttempts.providerMessageId, errorCode: deliveryAttempts.errorCode }).from(deliveryAttempts).innerJoin(reminders, eq(reminders.id, deliveryAttempts.reminderId)).where(eq(reminders.userId, user.id)).orderBy(desc(deliveryAttempts.createdAt)).limit(100);
    return NextResponse.json({ attempts: attempts.map((attempt) => ({ ...attempt, latencyMs: deliveryLatencyMs(attempt.scheduledAt, attempt.sentAt) })) });
  } catch (error) { return apiError(error); }
}
