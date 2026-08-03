import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { reminders } from "@/server/db/schema";
import { apiError } from "@/server/http";
import { cancelScheduledReminder, scheduleReminder } from "@/server/queue";
import { assertReminderCapacity, reminderQuota, ReminderLimitError } from "@/server/reminder-quota";
import { getSystemSettings } from "@/server/system-settings";

const createSchema = z.object({
  title: z.string().trim().min(1).max(200).refine((title) => title !== "新提醒", "请填写具体提醒事项"),
  originalInput: z.string().trim().min(1).max(500),
  scheduledAt: z.coerce.date().refine((date) => date.getTime() > Date.now(), "提醒时间必须在未来"),
  repeatRule: z.union([
    z.enum(["once", "daily", "weekdays", "weekly"]),
    z.string().regex(/^monthly:(?:last|[1-9]|[12]\d|3[01])$/, "每月提醒规则不正确"),
  ]),
  repeatUntil: z.coerce.date().nullable().optional(),
});

const createRequestSchema = z.union([
  createSchema,
  z.object({ reminders: z.array(createSchema).min(1).max(20) }).strict(),
]);

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const status = new URL(request.url).searchParams.get("status");
    const rows = await db.select().from(reminders).where(status && ["upcoming", "completed", "cancelled", "paused"].includes(status) ? and(eq(reminders.userId, user.id), eq(reminders.status, status as "upcoming")) : eq(reminders.userId, user.id)).orderBy(desc(reminders.scheduledAt));
    return NextResponse.json({ reminders: rows, quota: await reminderQuota(user) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    if (!(await getSystemSettings()).reminderCreationEnabled) return NextResponse.json({ error: "系统维护中，暂时无法新增提醒" }, { status: 503 });
    const user = await requireUser();
    const requestInput = createRequestSchema.parse(await request.json());
    const inputs = "reminders" in requestInput ? requestInput.reminders : [requestInput];
    const quota = await assertReminderCapacity(user, inputs.length);
    const savedReminders: (typeof reminders.$inferSelect)[] = [];
    const createdIds: string[] = [];
    try {
      for (const input of inputs) {
        const [created] = await db.insert(reminders).values({ userId: user.id, ...input }).returning();
        createdIds.push(created.id);
        const jobId = await scheduleReminder(created.id, created.scheduledAt);
        const [saved] = await db.update(reminders).set({ queueJobId: jobId, updatedAt: new Date() }).where(eq(reminders.id, created.id)).returning();
        savedReminders.push(saved);
      }
    } catch (error) {
      await Promise.all(savedReminders.map((item) => cancelScheduledReminder(item.queueJobId).catch(() => undefined)));
      if (createdIds.length) await db.delete(reminders).where(inArray(reminders.id, createdIds));
      throw error;
    }
    return NextResponse.json({
      reminder: savedReminders[0],
      reminders: savedReminders,
      quota: { activeCount: quota.activeCount + savedReminders.length, limit: quota.limit },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message || "提醒信息不正确" }, { status: 400 });
    if (error instanceof ReminderLimitError) return NextResponse.json({ error: error.message, code: error.code, limit: error.limit, activeCount: error.activeCount }, { status: 403 });
    return apiError(error);
  }
}

export async function DELETE() {
  try {
    const user = await requireUser();
    const active = await db.select({ id: reminders.id, queueJobId: reminders.queueJobId }).from(reminders).where(and(
      eq(reminders.userId, user.id),
      inArray(reminders.status, ["upcoming", "paused"]),
    ));
    if (!active.length) return NextResponse.json({ ok: true, cancelled: 0 });
    await db.update(reminders).set({ status: "cancelled", updatedAt: new Date() }).where(and(
      eq(reminders.userId, user.id),
      inArray(reminders.status, ["upcoming", "paused"]),
    ));
    await Promise.all(active.map((item) => cancelScheduledReminder(item.queueJobId).catch((error) => {
      console.error("Failed to cancel reminder during cancel-all", { reminderId: item.id, error: error instanceof Error ? error.message : "UNKNOWN" });
    })));
    return NextResponse.json({ ok: true, cancelled: active.length });
  } catch (error) {
    return apiError(error);
  }
}
