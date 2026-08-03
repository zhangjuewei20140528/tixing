import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { writeAdminAudit } from "@/server/admin-audit";
import { requireAdmin } from "@/server/auth";
import { db } from "@/server/db";
import { deliveryAttempts, reminders, wechatBindings } from "@/server/db/schema";
import { apiError } from "@/server/http";
import { scheduleReminderRetry } from "@/server/queue";

export async function POST() {
  try {
    const admin = await requireAdmin();
    const candidates = await db.select({ id: deliveryAttempts.id, attempt: deliveryAttempts.attempt, status: deliveryAttempts.status, reminderId: reminders.id, userId: reminders.userId, occurrenceAt: deliveryAttempts.scheduledAt })
      .from(deliveryAttempts).innerJoin(reminders, eq(reminders.id, deliveryAttempts.reminderId))
      .innerJoin(wechatBindings, and(eq(wechatBindings.userId, reminders.userId), eq(wechatBindings.status, "active")))
      .where(and(inArray(deliveryAttempts.status, ["failed", "blocked"]), isNull(deliveryAttempts.handledAt), eq(reminders.status, "upcoming"), eq(reminders.scheduledAt, deliveryAttempts.scheduledAt)))
      .orderBy(desc(deliveryAttempts.createdAt)).limit(20);
    let queued = 0;
    for (const delivery of candidates) {
      const [claimed] = await db.update(deliveryAttempts).set({ status: delivery.status, errorCode: null, errorMessage: null }).where(and(eq(deliveryAttempts.id, delivery.id), eq(deliveryAttempts.status, delivery.status))).returning({ id: deliveryAttempts.id });
      if (!claimed) continue;
      try {
        const jobId = await scheduleReminderRetry(delivery.reminderId, new Date(Date.now() + 250 + queued * 100), delivery.occurrenceAt, `${delivery.id}:${delivery.attempt + 1}`);
        if (!jobId) throw new Error("RETRY_JOB_NOT_CREATED");
        await db.update(reminders).set({ queueJobId: jobId, updatedAt: new Date() }).where(eq(reminders.id, delivery.reminderId));
        queued += 1;
      } catch {
        await db.update(deliveryAttempts).set({ status: delivery.status, errorCode: "BULK_RETRY_QUEUE_FAILED", errorMessage: "批量重试任务入队失败" }).where(eq(deliveryAttempts.id, delivery.id));
      }
    }
    await writeAdminAudit({ actorUserId: admin.id, action: "delivery.bulk_retry", targetType: "delivery", summary: `批量重试 ${queued} 条异常投递`, details: { queued } });
    return NextResponse.json({ ok: true, queued });
  } catch (error) {
    return apiError(error);
  }
}
